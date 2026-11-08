import type { SessionControllerSourceCustody } from "../../../sessions/session-controller.contracts.js";
import { FollowupRunDeferredError, type FollowupRun } from "./types.js";

export function updateFollowupRetryHeartbeatsWithCustody(
  error: unknown,
  sources: readonly FollowupRun[],
  resolveCustody: (run: FollowupRun) => SessionControllerSourceCustody,
): void {
  for (const source of sources) {
    if (error instanceof FollowupRunDeferredError) {
      startFollowupRunPreAdoptionHeartbeatWithCustody(source, () => resolveCustody(source));
    } else {
      resolveCustody(source).stopHeartbeat?.();
    }
  }
}

export function startFollowupRunPreAdoptionHeartbeatWithCustody(
  run: FollowupRun,
  resolveCustody: () => SessionControllerSourceCustody,
  abortSignal?: AbortSignal,
): (() => void) | undefined {
  const lifecycle = run.turnAdoptionLifecycle;
  if (!lifecycle) {
    return undefined;
  }
  const intervalMs = lifecycle.deferredHeartbeatIntervalMs;
  const heartbeat = lifecycle.onDeferredHeartbeat;
  if (
    !heartbeat ||
    !intervalMs ||
    !Number.isFinite(intervalMs) ||
    intervalMs <= 0 ||
    lifecycle.abortSignal?.aborted ||
    abortSignal?.aborted
  ) {
    return undefined;
  }
  const state = resolveCustody();
  if (state.adopted || state.completed) {
    return undefined;
  }
  state.stopHeartbeat?.();
  const stop = () => {
    clearInterval(timer);
    lifecycle.abortSignal?.removeEventListener("abort", stop);
    abortSignal?.removeEventListener("abort", stop);
    if (state.stopHeartbeat === stop) {
      state.stopHeartbeat = undefined;
    }
  };
  const pulse = () => {
    try {
      heartbeat();
    } catch {
      stop();
    }
  };
  const timer = setInterval(pulse, intervalMs).unref();
  state.stopHeartbeat = stop;
  lifecycle.abortSignal?.addEventListener("abort", stop, { once: true });
  abortSignal?.addEventListener("abort", stop, { once: true });
  pulse();
  return stop;
}
