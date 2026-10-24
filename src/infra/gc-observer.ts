import { GCProfiler } from "node:v8";

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
  /** Positive native before/after heap drop, not total allocated bytes. */
  reclaimedBytes?: number;
  heapUsedBeforeBytes?: number;
};

const kinds: Readonly<Record<string, GcSample["kind"]>> = {
  Scavenge: "scavenge",
  MinorMarkSweep: "scavenge",
  MarkSweepCompact: "mark_sweep_compact",
  IncrementalMarking: "incremental",
  ProcessWeakCallbacks: "weak_processing",
};

const subscribers = new Set<(samples: GcSample[]) => void>();
let profiler: GCProfiler | undefined;
let timer: NodeJS.Timeout | undefined;
let oldGenerationAfterGcBytes: number | undefined;

/** Last native major-GC epilogue, not memory sampled when JavaScript drains the profile. */
export function getOldGenerationAfterGcBytes(): number | undefined {
  return oldGenerationAfterGcBytes;
}

function drain(restart: boolean): void {
  const result = profiler?.stop();
  if (restart) {
    profiler?.start();
  }
  const samples: GcSample[] = [];
  for (const entry of result?.statistics ?? []) {
    const kind = kinds[entry.gcType];
    if (kind === "mark_sweep_compact") {
      oldGenerationAfterGcBytes = 0;
      for (const space of entry.afterGC.heapSpaceStatistics) {
        if (space.spaceName === "old_space" || space.spaceName === "large_object_space") {
          oldGenerationAfterGcBytes += space.spaceUsedSize;
        }
      }
    }
    if (kind) {
      // GCProfiler reports microseconds but does not expose callback flags.
      const before = entry.beforeGC.heapStatistics.usedHeapSize;
      samples.push({
        kind,
        reason: "other",
        durationMs: entry.cost / 1000,
        heapUsedBeforeBytes: before,
        reclaimedBytes: Math.max(0, before - entry.afterGC.heapStatistics.usedHeapSize),
      });
    }
  }
  if (samples.length) {
    for (const publish of subscribers) {
      publish(samples);
    }
  }
}

/** Include collections from short tasks before their worker can be terminated. */
export function flushGcSamples(): void {
  if (profiler) {
    drain(true);
  }
}

/** One native sampler per isolate; never enqueue JavaScript in response to a GC. */
export function observeGcSamples(publish: (samples: GcSample[]) => void): (() => void) | undefined {
  if (process.versions.bun) {
    return undefined;
  }
  if (profiler) {
    // Joining consumers must not receive collections preceding their activation.
    drain(true);
  } else {
    profiler = new GCProfiler();
    profiler.start();
    // A per-GC PerformanceObserver wakes idle workers after every collection and
    // can sustain a collection loop. Native profiling only wakes JS on this cadence.
    // Each restart replaces Node's native profiler; keep idle-worker churn to one per second.
    timer = setInterval(() => drain(true), 1000).unref();
  }
  subscribers.add(publish);
  return () => {
    if (!subscribers.has(publish)) {
      return;
    }
    const last = subscribers.size === 1;
    drain(!last);
    subscribers.delete(publish);
    if (last) {
      clearInterval(timer);
      timer = undefined;
      profiler = undefined;
      oldGenerationAfterGcBytes = undefined;
    }
  };
}
