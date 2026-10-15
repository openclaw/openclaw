import {
  constants,
  performance,
  PerformanceObserver,
  type PerformanceNodeEntry,
} from "node:perf_hooks";

export type GcSample = {
  kind: "scavenge" | "mark_sweep_compact" | "incremental" | "weak_processing";
  reason:
    | "none"
    | "forced"
    | "synchronous_phantom_processing"
    | "all_available_garbage"
    | "all_external_memory"
    | "schedule_idle"
    | "construct_retained"
    | "other";
  durationMs: number;
};

const kinds: Readonly<Record<number, GcSample["kind"]>> = {
  [constants.NODE_PERFORMANCE_GC_MINOR]: "scavenge",
  [constants.NODE_PERFORMANCE_GC_MAJOR]: "mark_sweep_compact",
  [constants.NODE_PERFORMANCE_GC_INCREMENTAL]: "incremental",
  [constants.NODE_PERFORMANCE_GC_WEAKCB]: "weak_processing",
};

// Node exposes callback flags, not V8's complete internal collection cause.
const reasons: Readonly<Record<number, GcSample["reason"]>> = {
  [constants.NODE_PERFORMANCE_GC_FLAGS_NO]: "none",
  [constants.NODE_PERFORMANCE_GC_FLAGS_FORCED]: "forced",
  [constants.NODE_PERFORMANCE_GC_FLAGS_SYNCHRONOUS_PHANTOM_PROCESSING]:
    "synchronous_phantom_processing",
  [constants.NODE_PERFORMANCE_GC_FLAGS_ALL_AVAILABLE_GARBAGE]: "all_available_garbage",
  [constants.NODE_PERFORMANCE_GC_FLAGS_ALL_EXTERNAL_MEMORY]: "all_external_memory",
  [constants.NODE_PERFORMANCE_GC_FLAGS_SCHEDULE_IDLE]: "schedule_idle",
  [constants.NODE_PERFORMANCE_GC_FLAGS_CONSTRUCT_RETAINED]: "construct_retained",
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
      const { kind: nativeKind, flags } = (entry as PerformanceNodeEntry).detail;
      const kind = kinds[nativeKind];
      // A replacement observer can receive native entries queued before activation.
      if (kind && entry.startTime >= activatedAt) {
        samples.push({ kind, reason: reasons[flags] ?? "other", durationMs: entry.duration });
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
