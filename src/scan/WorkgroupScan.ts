import { HasReactive, reactively } from "@reactively/decorate";
import { createDebugBuffer } from "thimbleberry";
import { gpuTiming } from "thimbleberry";
import { limitWorkgroupLength } from "thimbleberry";
import { assignParams, reactiveTrackUse } from "thimbleberry";
import { trackContext } from "thimbleberry";
import { getWorkgroupScanPipeline } from "./WorkgroupScanPipeline";
import { ScanTemplate, sumU32 } from "./ScanTemplate.js";
import { Cache, ComposableShader, ValueOrFn } from "./Scan.js";

export interface WorkgroupScanArgs {
  device: GPUDevice;
  source: ValueOrFn<GPUBuffer>;
  emitBlockSums?: ValueOrFn<boolean>;
  workgroupLength?: ValueOrFn<number>;
  label?: ValueOrFn<string>;
  template?: ValueOrFn<ScanTemplate>;
  pipelineCache?: <T extends object>() => Cache<T>;
}

const defaults: Partial<WorkgroupScanArgs> = {
  emitBlockSums: true,
  pipelineCache: undefined,
  label: "prefix scan",
  template: sumU32,
};

/**
 * Prefix scan operation on workgroup sized blocks of data.
 *
 * Internally allocates an output buffer for the prefix scan results.
 * The output buffer will be the same dimensions as the input buffer.
 *
 * Optionally allocates a block level summary buffer, containing
 * one summariy entry per input block.
 */
export class WorkgroupScan extends HasReactive implements ComposableShader {
  @reactively source!: GPUBuffer;
  @reactively workgroupLength?: number;
  @reactively template!: ScanTemplate;
  @reactively emitBlockSums!: boolean;
  @reactively label!: string;

  private device!: GPUDevice;
  private pipelineCache?: <T extends object>() => Cache<T>;
  private usageContext = trackContext();

  constructor(params: WorkgroupScanArgs) {
    super();
    assignParams<WorkgroupScan>(this, params, defaults);
  }

  commands(commandEncoder: GPUCommandEncoder): void {
    const timestampWrites = gpuTiming?.timestampWrites(this.label) ?? [];
    const passEncoder = commandEncoder.beginComputePass({ timestampWrites });
    passEncoder.label = this.label;
    passEncoder.setPipeline(this.pipeline);
    passEncoder.setBindGroup(0, this.bindGroup);
    passEncoder.dispatchWorkgroups(this.dispatchSize, 1, 1);
    passEncoder.end();
  }

  destroy(): void {
    this.usageContext.finish();
  }

  @reactively private get dispatchSize(): number {
    const sourceElems = this.sourceSize / Uint32Array.BYTES_PER_ELEMENT;
    const dispatchSize = Math.ceil(sourceElems / this.actualWorkgroupLength);
    return dispatchSize;
  }

  @reactively private get pipeline(): GPUComputePipeline {
    return getWorkgroupScanPipeline(
      {
        device: this.device,
        workgroupSize: this.actualWorkgroupLength,
        blockSums: this.emitBlockSums,
        template: this.template,
      },
      this.pipelineCache
    );
  }

  @reactively private get bindGroup(): GPUBindGroup {
    let blockSumsEntry: GPUBindGroupEntry[] = [];
    if (this.emitBlockSums) {
      blockSumsEntry = [{ binding: 3, resource: { buffer: this.blockSums } }];
    }

    return this.device.createBindGroup({
      label: `workgroup scan`,
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 1, resource: { buffer: this.source } },
        { binding: 2, resource: { buffer: this.prefixScan } },
        ...blockSumsEntry,
        { binding: 11, resource: { buffer: this.debugBuffer } },
      ],
    });
  }

  @reactively get sourceSize(): number {
    return this.source.size;
  }

  @reactively get prefixScan(): GPUBuffer {
    const buffer = this.device.createBuffer({
      label: `prefix scan ${this.label}`,
      size: this.sourceSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    reactiveTrackUse(buffer, this.usageContext);
    return buffer;
  }

  @reactively get blockSums(): GPUBuffer {
    // ensure size is a multiple of 4
    const buffer = this.device.createBuffer({
      label: `prefix scan block sums ${this.label}`,
      size: this.dispatchSize * Uint32Array.BYTES_PER_ELEMENT,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    reactiveTrackUse(buffer, this.usageContext);
    return buffer;
  }

  @reactively get actualWorkgroupLength(): number {
    return limitWorkgroupLength(this.device, this.workgroupLength);
  }

  @reactively get debugBuffer(): GPUBuffer {
    const buffer = createDebugBuffer(this.device, "Workgroup Scan debug");
    reactiveTrackUse(buffer, this.usageContext);
    return buffer;
  }
}