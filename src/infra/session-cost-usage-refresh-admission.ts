import { createPermitPool } from "../shared/permit-pool.js";

// Bound independent per-agent queues before they reach the shared worker lanes.
const usageCostRefreshPermits = createPermitPool(2);

type UsageCostRefreshAdmissionState = {
  readingSessionFiles: { size: number };
  resume?: () => void;
};

type UsageCostRefreshAdmission =
  | { kind: "aborted" }
  | { kind: "retry" }
  | { kind: "ready"; releasePermit: (() => void) | null };

export async function acquireUsageCostRefreshPermit(
  state: UsageCostRefreshAdmissionState,
  signal: AbortSignal | undefined,
): Promise<UsageCostRefreshAdmission> {
  let releasePermit: (() => void) | null = null;
  if (state.readingSessionFiles.size === 0) {
    const permitWait = new AbortController();
    const abortForScope = () => permitWait.abort(signal?.reason);
    const resumeForRead = () => {
      if (state.readingSessionFiles.size > 0) {
        permitWait.abort();
      }
    };
    signal?.addEventListener("abort", abortForScope, { once: true });
    state.resume = resumeForRead;
    try {
      releasePermit = await usageCostRefreshPermits.acquire({ signal: permitWait.signal });
    } finally {
      signal?.removeEventListener("abort", abortForScope);
      if (state.resume === resumeForRead) {
        state.resume = undefined;
      }
    }
  }
  if (signal?.aborted) {
    releasePermit?.();
    return { kind: "aborted" };
  }
  // A report waiting on this refresh may pass the fleet-wide queue once.
  if (!releasePermit && state.readingSessionFiles.size === 0) {
    return { kind: "retry" };
  }
  return { kind: "ready", releasePermit };
}
