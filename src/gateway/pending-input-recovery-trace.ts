import { performance } from "node:perf_hooks";

type PendingInputRecoveryPhase =
  | "sourceLoadMs"
  | "sessionLoadMs"
  | "authorityRestoreMs"
  | "communicationAdmissionMs"
  | "dispatchAckMs"
  | "retryWaitMs";

export type PendingInputRecoveryTrace = ReturnType<typeof createPendingInputRecoveryTrace>;

/** One input's inclusive wall times, accumulated across its retry attempts. */
export function createPendingInputRecoveryTrace() {
  const startedAt = performance.now();
  const timings: Record<PendingInputRecoveryPhase, number> = {
    sourceLoadMs: 0,
    sessionLoadMs: 0,
    authorityRestoreMs: 0,
    communicationAdmissionMs: 0,
    dispatchAckMs: 0,
    retryWaitMs: 0,
  };
  return {
    async measure<T>(phase: PendingInputRecoveryPhase, operation: () => Promise<T>): Promise<T> {
      const before = performance.now();
      try {
        return await operation();
      } finally {
        timings[phase] += performance.now() - before;
      }
    },
    finish: () => ({ totalMs: performance.now() - startedAt, ...timings }),
  };
}
