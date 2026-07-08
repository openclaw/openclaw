// Leaf state for the config hot-reload watcher's disk observations.
// Kept separate from config-reload.ts so consumers that only need the
// observation counter (health drift summaries) do not pull in the full
// reloader implementation.

// Monotonic count of disk-config observations (watcher snapshot reads and
// in-process write candidates, applied or not). The reloader is the canonical
// observer of config-file changes; health keys its single-slot drift cache on
// this so cache hits never re-read openclaw.json (ClawSweeper P1 #89526).
let configReloadObservedGeneration = 0;

export function bumpConfigReloadObservedGeneration(): void {
  configReloadObservedGeneration += 1;
}

export function getConfigReloadObservedGeneration(): number {
  return configReloadObservedGeneration;
}
