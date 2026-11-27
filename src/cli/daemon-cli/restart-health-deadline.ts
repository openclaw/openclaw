import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { racePromiseWithAbortSignal } from "../../../packages/retry/src/index.js";
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
export function createGatewayRestartDeadline(params: {
  timeoutMs: number;
  signal?: AbortSignal;
  timeoutError?: Error;
}) {
  const startedAtMs = performance.now();
  let deadlineMs = startedAtMs + params.timeoutMs;
  const controller = new AbortController();
  let activePhase: string | undefined;
  let lastPhase = "setup";
  let expiredPhase: string | undefined;
  let expiredElapsedMs: number | undefined;
  let cleanupStatus: GatewayRestartCleanup | undefined;
  let cleanup: Promise<Exclude<GatewayRestartCleanup, "pending">> | undefined;
  const expire = () => {
    if (!controller.signal.aborted) {
      expiredPhase = activePhase ?? lastPhase;
      expiredElapsedMs = Math.round(Math.max(0, performance.now() - startedAtMs));
      controller.abort(params.timeoutError ?? new GatewayRestartDeadlineError(expiredPhase));
    }
  };
  let cancelTimer = scheduleAbsoluteDeadline(deadlineMs, expire, () => performance.now());
  const cancelFromCaller = () => controller.abort(params.signal?.reason);
  params.signal?.addEventListener("abort", cancelFromCaller, { once: true });
  if (params.signal?.aborted) {
    cancelFromCaller();
  }
  return {
    get deadlineMs() {
      return deadlineMs;
    },
    signal: controller.signal,
    /**
     * Runs work that the operator's budget does not cover (it has its own bound): the
     * deadline stops while it runs and then moves by its duration. An expired budget stays
     * expired.
     */
    async exclude<T>(operation: () => Promise<T>): Promise<T> {
      if (performance.now() >= deadlineMs) {
        expire();
      }
      controller.signal.throwIfAborted();
      cancelTimer();
      const pausedAtMs = performance.now();
      try {
        return await operation();
      } finally {
        deadlineMs += performance.now() - pausedAtMs;
        cancelTimer = scheduleAbsoluteDeadline(deadlineMs, expire, () => performance.now());
      }
    },
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
    remainingMs: () => {
      if (performance.now() >= deadlineMs) {
        expire();
      }
      return Math.max(0, deadlineMs - performance.now());
    },
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
        const result = await racePromiseWithAbortSignal(operation(), controller.signal, (signal) =>
          toErrorObject(signal.reason, "Gateway restart observation canceled."),
        );
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
