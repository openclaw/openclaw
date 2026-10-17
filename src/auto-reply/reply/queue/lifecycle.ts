import { defaultRuntime } from "../../../runtime.js";
import type { TurnAdoptionLifecycle } from "../../get-reply-options.types.js";
import { FollowupRunDeferredError, type FollowupRun } from "./types.js";

type LifecycleState = {
  enqueued?: boolean;
  admitted?: boolean;
  admitting?: Promise<void>;
  cancellationRetired?: boolean;
  completed?: boolean;
  stopHeartbeat?: () => void;
};

const lifecycleStates = new WeakMap<TurnAdoptionLifecycle, LifecycleState>();

function getLifecycleState(lifecycle: TurnAdoptionLifecycle): LifecycleState {
  let state = lifecycleStates.get(lifecycle);
  if (!state) {
    state = {};
    lifecycleStates.set(lifecycle, state);
  }
  return state;
}

type FollowupLifecycleRun = Pick<
  FollowupRun,
  "steerPending" | "turnAdoptionLifecycle" | "operatorAuthority"
>;

function stopFollowupRunPreAdoptionHeartbeat(lifecycle: TurnAdoptionLifecycle | undefined): void {
  if (lifecycle) {
    lifecycleStates.get(lifecycle)?.stopHeartbeat?.();
  }
}

export function updateFollowupRetryHeartbeats(
  error: unknown,
  sources: readonly FollowupRun[],
): void {
  // Preparation failures stop renewal; a later capacity wait restores source liveness.
  for (const source of sources) {
    if (error instanceof FollowupRunDeferredError) {
      startFollowupRunPreAdoptionHeartbeat(source.turnAdoptionLifecycle);
    } else {
      stopFollowupRunPreAdoptionHeartbeat(source.turnAdoptionLifecycle);
    }
  }
}

export function startFollowupRunPreAdoptionHeartbeat(
  lifecycle: TurnAdoptionLifecycle | undefined,
  abortSignal?: AbortSignal,
): (() => void) | undefined {
  if (!lifecycle) {
    return undefined;
  }
  const intervalMs = lifecycle.deferredHeartbeatIntervalMs;
  const heartbeat = lifecycle.onDeferredHeartbeat;
  const state = getLifecycleState(lifecycle);
  if (
    !heartbeat ||
    intervalMs === undefined ||
    !Number.isFinite(intervalMs) ||
    intervalMs <= 0 ||
    lifecycle.abortSignal?.aborted ||
    abortSignal?.aborted ||
    state.admitted ||
    state.completed
  ) {
    return undefined;
  }
  stopFollowupRunPreAdoptionHeartbeat(lifecycle);
  const pulse = () => {
    try {
      heartbeat();
    } catch {
      // Leave recovery to the ingress watchdog when its liveness callback fails.
      stopFollowupRunPreAdoptionHeartbeat(lifecycle);
    }
  };
  const timer = setInterval(pulse, intervalMs).unref();
  const stop = () => {
    clearInterval(timer);
    lifecycle.abortSignal?.removeEventListener("abort", stop);
    abortSignal?.removeEventListener("abort", stop);
    if (state.stopHeartbeat === stop) {
      state.stopHeartbeat = undefined;
    }
  };
  state.stopHeartbeat = stop;
  lifecycle.abortSignal?.addEventListener("abort", stop, { once: true });
  abortSignal?.addEventListener("abort", stop, { once: true });
  pulse();
  return stop;
}

export function markFollowupRunEnqueued(run: FollowupLifecycleRun): boolean {
  const authority = run.operatorAuthority;
  authority?.signal?.throwIfAborted();
  authority?.assertCurrent();
  // Delivery recovery has a fresh queue lifetime after its parent turn settles.
  const lifecycle =
    run.turnAdoptionLifecycle ??
    (authority
      ? (run.turnAdoptionLifecycle = { admission: "cancel-only", onAdopted: () => {} })
      : undefined);
  if (lifecycle && !getLifecycleState(lifecycle).enqueued) {
    if (lifecycle.onDeferred?.() === false) {
      return false;
    }
    let releaseAuthority: (() => void) | undefined;
    try {
      releaseAuthority = authority?.retain?.();
    } catch (error) {
      completeFollowupRunLifecycle(run);
      throw error;
    }
    if (releaseAuthority) {
      const release = releaseAuthority;
      const onSettled = lifecycle.onSettled;
      lifecycle.onSettled = () => {
        try {
          onSettled?.();
        } finally {
          release();
        }
      };
    }
    getLifecycleState(lifecycle).enqueued = true;
    startFollowupRunPreAdoptionHeartbeat(lifecycle);
  }
  return true;
}

/**
 * Dedupe owners must free their entry before durable ingress retries the turn.
 * Cancellation and abandonment are both pre-retry releases, so hook whichever
 * terminal callbacks this lifecycle actually exposes.
 */
export function releaseBeforeTurnAdoptionRetry(
  lifecycle: TurnAdoptionLifecycle,
  release: () => void,
): void {
  const onAbandoned = lifecycle.onAbandoned;
  // Hand the callback's result back so core can contain an async rejection.
  lifecycle.onAbandoned = () => {
    release();
    return onAbandoned?.();
  };
  const onCancelled = lifecycle.onCancelled;
  if (onCancelled) {
    lifecycle.onCancelled = () => {
      release();
      return onCancelled();
    };
  }
}

export function retireFollowupRunCancellation(run: FollowupLifecycleRun): void {
  const lifecycle = run.turnAdoptionLifecycle;
  if (!lifecycle) {
    return;
  }
  const state = getLifecycleState(lifecycle);
  if (state.cancellationRetired) {
    return;
  }
  state.cancellationRetired = true;
  lifecycle.onCancellationRetired?.();
}

export async function admitFollowupRunLifecycle(run: FollowupLifecycleRun): Promise<void> {
  run.operatorAuthority?.assertCurrent();
  const lifecycle = run.turnAdoptionLifecycle;
  if (!lifecycle) {
    return;
  }
  const state = getLifecycleState(lifecycle);
  if (state.admitted) {
    return;
  }
  if (state.admitting) {
    await state.admitting;
    return;
  }
  if (state.completed) {
    throw new Error("followup run lifecycle completed before admission");
  }

  const admission = Promise.resolve().then(async () => {
    await lifecycle.onAdopted();
    run.operatorAuthority?.assertCurrent();
    state.admitted = true;
    stopFollowupRunPreAdoptionHeartbeat(lifecycle);
  });

  state.admitting = admission;
  try {
    await admission;
  } finally {
    state.admitting = undefined;
  }
}

export function completeFollowupRunLifecycle(
  run: FollowupLifecycleRun,
  disposition?: "consumed" | "cancelled",
): void {
  try {
    run.steerPending?.settle(false);
  } finally {
    // A failed steer notification must not strand already-detached lifecycle custody.
    const lifecycle = run.turnAdoptionLifecycle;
    if (lifecycle) {
      const state = getLifecycleState(lifecycle);
      if (!state.completed) {
        state.completed = true;
        stopFollowupRunPreAdoptionHeartbeat(lifecycle);
        // Terminal callbacks start synchronously and onSettled runs right after,
        // even after a synchronous throw. Async adapter work is not awaited, so its
        // rejection is contained here instead of escaping as an unhandled rejection.
        const containSettlement = (settlement: unknown, label: string) => {
          void Promise.resolve(settlement).catch((error: unknown) => {
            defaultRuntime.error?.(`followup queue ${label} failed: ${String(error)}`);
          });
        };
        const finish = () => {
          try {
            if (disposition !== "consumed" && !state.admitted) {
              // Cancellation ended ownership before the reply lane, so it settles
              // through the cancel callback and leaves the retry budget untouched.
              // An explicit "cancelled" disposition and an already-aborted signal
              // are the same end of ownership, so either takes the cancel path.
              if (
                (disposition === "cancelled" || lifecycle.abortSignal?.aborted) &&
                lifecycle.onCancelled
              ) {
                containSettlement(lifecycle.onCancelled(), "cancellation");
              } else {
                // Typed void, but channel adapters may still return a promise.
                containSettlement(lifecycle.onAbandoned?.(), "abandonment");
              }
            }
          } finally {
            lifecycle.onSettled?.();
          }
        };

        if (!state.admitting) {
          finish();
        } else {
          // Completion closes future admission immediately, but the callback waits for
          // the in-flight admission attempt so adoption and abandonment cannot race.
          void state.admitting.then(finish, finish).catch(() => {
            // Detached settlement callbacks cannot reject back into a completed queue item.
          });
        }
      }
    }
  }
}

export function completeFollowupRuns(
  items: Iterable<FollowupLifecycleRun>,
  onError?: (error: unknown) => void,
  disposition?: "consumed" | "cancelled",
): void {
  for (const item of items) {
    try {
      completeFollowupRunLifecycle(item, disposition);
    } catch (error) {
      if (!onError) {
        throw error;
      }
      onError(error);
    }
  }
}
