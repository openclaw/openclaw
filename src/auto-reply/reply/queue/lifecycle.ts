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
  disposition?: "consumed",
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
        const finish = () => {
          // Async onAbandoned work must contain its own rejections; core guarantees a
          // non-rejecting promise. onSettled must still run after a synchronous throw.
          try {
            if (disposition !== "consumed" && !state.admitted) {
              lifecycle.onAbandoned?.();
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
): void {
  for (const item of items) {
    try {
      completeFollowupRunLifecycle(item);
    } catch (error) {
      if (!onError) {
        throw error;
      }
      onError(error);
    }
  }
}
