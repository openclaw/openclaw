import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { hasCommandProcessCleanupError } from "../../process/exec-result.js";
import { withCommandProcessScope } from "../../process/exec-spawn.js";
import { scheduleAbsoluteDeadline } from "../../utils/absolute-deadline.js";

export class GatewayRestartDeadlineError extends Error {
  constructor(readonly phase: string) {
    super(`Gateway restart observation timed out during ${phase}.`);
    this.name = "GatewayRestartDeadlineError";
  }
}

export type GatewayRestartDeadline = ReturnType<typeof createGatewayRestartDeadline>;
export type GatewayRestartCleanup = "pending" | "confirmed" | "unknown";

/** One monotonic deadline covers setup, health, and reconciliation reads. */
export function createGatewayRestartDeadline(params: { timeoutMs: number; signal?: AbortSignal }) {
  const startedAtMs = performance.now();
  const deadlineMs = startedAtMs + params.timeoutMs;
  const controller = new AbortController();
  let activePhase: string | undefined;
  let lastPhase = "setup";
  let expiredPhase: string | undefined;
  let expiredElapsedMs: number | undefined;
  let cleanupStatus: GatewayRestartCleanup | undefined;
  let cleanup: Promise<Exclude<GatewayRestartCleanup, "pending">> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener(
      "abort",
      () =>
        reject(toErrorObject(controller.signal.reason, "Gateway restart observation canceled.")),
      { once: true },
    );
  });
  // Expiry can happen between reads; the next read still observes the same rejection.
  void expired.catch(() => undefined);
  const expire = () => {
    if (!controller.signal.aborted) {
      expiredPhase = activePhase ?? lastPhase;
      expiredElapsedMs = Math.round(Math.max(0, performance.now() - startedAtMs));
      controller.abort(new GatewayRestartDeadlineError(expiredPhase));
    }
  };
  const cancelTimer = scheduleAbsoluteDeadline(deadlineMs, expire, () => performance.now());
  const cancelFromCaller = () => controller.abort(params.signal?.reason);
  params.signal?.addEventListener("abort", cancelFromCaller, { once: true });
  if (params.signal?.aborted) {
    cancelFromCaller();
  }
  return {
    deadlineMs,
    signal: controller.signal,
    get phase() {
      return activePhase ?? lastPhase;
    },
    get expiredPhase() {
      return expiredPhase;
    },
    get timeout() {
      return expiredPhase === undefined || expiredElapsedMs === undefined
        ? undefined
        : { phase: expiredPhase, elapsedMs: expiredElapsedMs };
    },
    get cleanupStatus() {
      return cleanupStatus;
    },
    get cleanup() {
      return cleanup;
    },
    elapsedMs: () => Math.max(0, performance.now() - startedAtMs),
    remainingMs: () => Math.max(0, deadlineMs - performance.now()),
    async run<T>(operation: () => Promise<T>): Promise<T> {
      return await this.read("settlement", () => {
        cleanupStatus = "pending";
        const work = withCommandProcessScope(operation, controller.signal);
        // Command custody outlives the bounded observation, including abort cleanup.
        cleanup = work.then(
          () => (cleanupStatus = "confirmed"),
          (error: unknown) =>
            (cleanupStatus = hasCommandProcessCleanupError(error) ? "unknown" : "confirmed"),
        );
        return work;
      });
    },
    async read<T>(readPhase: string, operation: () => Promise<T>): Promise<T> {
      const previousPhase = activePhase;
      activePhase = readPhase;
      try {
        if (performance.now() >= deadlineMs) {
          expire();
        }
        controller.signal.throwIfAborted();
        const result = await Promise.race([expired, operation()]);
        if (performance.now() >= deadlineMs) {
          expire();
        }
        controller.signal.throwIfAborted();
        return result;
      } finally {
        activePhase = previousPhase;
        lastPhase = readPhase;
      }
    },
    dispose() {
      cancelTimer();
      params.signal?.removeEventListener("abort", cancelFromCaller);
      controller.abort(new Error("Gateway restart observation finished."));
    },
  };
}
