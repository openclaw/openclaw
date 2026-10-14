import {
  constants,
  performance,
  PerformanceObserver,
  type PerformanceNodeEntry,
} from "node:perf_hooks";

export type GcSample = {
  kind: "scavenge" | "mark_sweep_compact" | "incremental" | "weak_processing";
  durationMs: number;
};

const kinds: Readonly<Record<number, GcSample["kind"]>> = {
  [constants.NODE_PERFORMANCE_GC_MINOR]: "scavenge",
  [constants.NODE_PERFORMANCE_GC_MAJOR]: "mark_sweep_compact",
  [constants.NODE_PERFORMANCE_GC_INCREMENTAL]: "incremental",
  [constants.NODE_PERFORMANCE_GC_WEAKCB]: "weak_processing",
};

/** One observer per isolate owner; native batches travel together on worker ports. */
export function observeGcSamples(publish: (samples: GcSample[]) => void): (() => void) | undefined {
  if (!PerformanceObserver.supportedEntryTypes.includes("gc")) {
    return undefined;
  }
  const activatedAt = performance.now();
  let active = true;
  const observer = new PerformanceObserver((list) => {
    if (!active) {
      return;
    }
    const samples: GcSample[] = [];
    for (const entry of list.getEntries()) {
      // SAFETY: This gc-only observer receives Node entries with detail; Node types are not discriminated.
      const kind = kinds[(entry as PerformanceNodeEntry).detail.kind];
      // A replacement observer can receive native entries queued before activation.
      if (kind && entry.startTime >= activatedAt) {
        samples.push({ kind, durationMs: entry.duration });
      }
    }
    if (samples.length) {
      publish(samples);
    }
  });
  observer.observe({ entryTypes: ["gc"] });
  return () => {
    active = false;
    observer.disconnect();
  };
}
