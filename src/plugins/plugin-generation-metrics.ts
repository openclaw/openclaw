import { AsyncLocalStorage } from "node:async_hooks";

/** Preparation work; timings overlap when different owners prepare concurrently. */
export type PluginGenerationMetrics = {
  captures: number;
  captureReuse: number;
  packageFiles: number;
  dependencyFiles: number;
  /** Logical byte size selected from the original tree, excluding retained ordinary content. */
  originalBytes: number;
  /** Logical bytes copied; filesystem cloning may avoid physical block transfers. */
  copiedBytes: number;
  receiptPasses: number;
  receiptFileReads: number;
  receiptReadBytes: number;
  hashReadBytes: number;
  /** Worker-observed operation duration, including admission and callback waits. */
  workerMs: number;
  /** Host-observed round-trip duration; overlaps workerMs, not host CPU time. */
  hostMs: number;
};

const preparationMetrics = new AsyncLocalStorage<PluginGenerationMetrics>();

export function createPluginGenerationMetrics(): PluginGenerationMetrics {
  return {
    captures: 0,
    captureReuse: 0,
    packageFiles: 0,
    dependencyFiles: 0,
    originalBytes: 0,
    copiedBytes: 0,
    receiptPasses: 0,
    receiptFileReads: 0,
    receiptReadBytes: 0,
    hashReadBytes: 0,
    workerMs: 0,
    hostMs: 0,
  };
}

export function withPluginGenerationMetrics<T>(metrics: PluginGenerationMetrics, run: () => T): T {
  return preparationMetrics.run(metrics, run);
}

export function getPluginGenerationMetrics(): PluginGenerationMetrics | undefined {
  return preparationMetrics.getStore();
}

export function addPluginGenerationMetrics(
  target: PluginGenerationMetrics | undefined,
  source: PluginGenerationMetrics,
): void {
  if (target) {
    // SAFETY: These module-owned metrics records contain only the declared numeric fields.
    for (const key of Object.keys(source) as Array<keyof PluginGenerationMetrics>) {
      target[key] += source[key];
    }
  }
}
