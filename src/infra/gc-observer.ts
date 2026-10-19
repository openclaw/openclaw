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

function drain(restart: boolean): void {
  const result = profiler?.stop();
  if (restart) {
    profiler?.start();
  }
  const samples: GcSample[] = [];
  for (const entry of result?.statistics ?? []) {
    const kind = kinds[entry.gcType];
    if (kind) {
      // GCProfiler reports microseconds but does not expose callback flags.
      samples.push({ kind, reason: "other", durationMs: entry.cost / 1000 });
    }
  }
  if (samples.length) {
    for (const publish of subscribers) {
      publish(samples);
    }
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
    }
  };
}
