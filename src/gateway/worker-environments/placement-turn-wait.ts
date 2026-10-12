import { required, type WorkerSessionPlacementRecord } from "./placement-record.js";
import { removeTurnClaimReleaseWaiter, waitersFor } from "./placement-turn-claim-events.js";

/** Register before the worker read so a release cannot be lost while the read is pending. */
export function waitForPlacementTurnClaimRelease(
  path: string,
  sessionIdInput: string,
  options: { timeoutMs?: number; signal?: AbortSignal },
  read: (sessionId: string) => Promise<WorkerSessionPlacementRecord | undefined>,
): Promise<void> {
  const sessionId = required(sessionIdInput, "session id");
  if (
    options.timeoutMs !== undefined &&
    (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 0)
  ) {
    return Promise.reject(
      new Error("Worker session turn claim wait timeout must be a non-negative integer"),
    );
  }
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      options.signal?.removeEventListener("abort", onAbort);
      removeTurnClaimReleaseWaiter(path, sessionId, finish);
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
    const onAbort = () => finish(new Error(`Turn claim wait aborted for session ${sessionId}`));
    waitersFor(path, sessionId).add(finish);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    if (options.timeoutMs !== undefined) {
      timer = setTimeout(
        () => finish(new Error(`Timed out waiting for session ${sessionId} turn claim release`)),
        options.timeoutMs,
      );
    }
    void read(sessionId).then(
      (placement) => {
        if (!placement?.turnClaim) {
          finish();
        }
      },
      (error: unknown) => finish(error instanceof Error ? error : new Error(String(error))),
    );
  });
}
