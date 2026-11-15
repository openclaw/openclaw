import { performance } from "node:perf_hooks";

/** Request-local totals; overlapping scopes contribute independently. */
export function createPhaseTimings<Phase extends string>() {
  const totals = new Map<Phase, number>();
  const active = new Set<(now: number) => void>();
  return {
    totals,
    flush(now: number) {
      for (const record of active) {
        record(now);
      }
    },
    close() {
      active.clear();
    },
    scope(initialPhase: Phase) {
      let phase: Phase | undefined = initialPhase;
      let startedAt = performance.now();
      const record = (now: number) => {
        if (phase) {
          totals.set(phase, (totals.get(phase) ?? 0) + now - startedAt);
        }
        startedAt = now;
      };
      active.add(record);
      const scope = {
        mark(next?: Phase) {
          if (active.has(record)) {
            record(performance.now());
            phase = next;
          }
        },
        finish(this: void) {
          scope.mark();
          active.delete(record);
        },
        [Symbol.dispose]() {
          scope.finish();
        },
      };
      return scope;
    },
  };
}
