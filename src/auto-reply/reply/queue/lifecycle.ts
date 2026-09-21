import type { TurnAdoptionLifecycle } from "../../get-reply-options.types.js";
import type { FollowupRun } from "./types.js";

const enqueuedTurnAdoptionLifecycles = new WeakSet<TurnAdoptionLifecycle>();
const admittedTurnAdoptionLifecycles = new WeakSet<TurnAdoptionLifecycle>();
const admittingTurnAdoptionLifecycles = new WeakMap<TurnAdoptionLifecycle, Promise<void>>();
const retiredTurnAdoptionCancellationLifecycles = new WeakSet<TurnAdoptionLifecycle>();
const completedTurnAdoptionLifecycles = new WeakSet<TurnAdoptionLifecycle>();
const completedTurnAdoptionLifecycleCallbacks = new WeakSet<TurnAdoptionLifecycle>();
const deferredHeartbeatStops = new WeakMap<TurnAdoptionLifecycle, () => void>();

type FollowupLifecycleRun = Pick<
  FollowupRun,
  "steerPending" | "turnAdoptionLifecycle" | "operatorAuthority"
>;

export function startFollowupRunPreAdoptionHeartbeat(
  lifecycle: TurnAdoptionLifecycle | undefined,
  abortSignal?: AbortSignal,
): (() => void) | undefined {
  if (!lifecycle) {
    return undefined;
  }
  const intervalMs = lifecycle.deferredHeartbeatIntervalMs;
  const heartbeat = lifecycle.onDeferredHeartbeat;
  if (
    !heartbeat ||
    intervalMs === undefined ||
    !Number.isFinite(intervalMs) ||
    intervalMs <= 0 ||
    lifecycle.abortSignal?.aborted ||
    abortSignal?.aborted ||
    admittedTurnAdoptionLifecycles.has(lifecycle) ||
    completedTurnAdoptionLifecycles.has(lifecycle)
  ) {
    return undefined;
  }
  deferredHeartbeatStops.get(lifecycle)?.();
  const pulse = () => {
    try {
      heartbeat();
    } catch {
      // Leave recovery to the ingress watchdog when its liveness callback fails.
      deferredHeartbeatStops.get(lifecycle)?.();
    }
  };
  const timer = setInterval(pulse, intervalMs).unref();
  const stop = () => {
    clearInterval(timer);
    lifecycle.abortSignal?.removeEventListener("abort", stop);
    abortSignal?.removeEventListener("abort", stop);
    if (deferredHeartbeatStops.get(lifecycle) === stop) {
      deferredHeartbeatStops.delete(lifecycle);
    }
  };
  deferredHeartbeatStops.set(lifecycle, stop);
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
  if (lifecycle && !enqueuedTurnAdoptionLifecycles.has(lifecycle)) {
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
    enqueuedTurnAdoptionLifecycles.add(lifecycle);
    startFollowupRunPreAdoptionHeartbeat(lifecycle);
  }
  return true;
}

export function retireFollowupRunCancellation(run: FollowupLifecycleRun): void {
  const lifecycle = run.turnAdoptionLifecycle;
  if (!lifecycle || retiredTurnAdoptionCancellationLifecycles.has(lifecycle)) {
    return;
  }
  retiredTurnAdoptionCancellationLifecycles.add(lifecycle);
  lifecycle.onCancellationRetired?.();
}

export async function admitFollowupRunLifecycle(run: FollowupLifecycleRun): Promise<void> {
  run.operatorAuthority?.assertCurrent();
  const lifecycle = run.turnAdoptionLifecycle;
  if (!lifecycle || admittedTurnAdoptionLifecycles.has(lifecycle)) {
    return;
  }
  const existing = admittingTurnAdoptionLifecycles.get(lifecycle);
  if (existing) {
    await existing;
    return;
  }
  if (completedTurnAdoptionLifecycles.has(lifecycle)) {
    throw new Error("followup run lifecycle completed before admission");
  }

  const admission = Promise.resolve().then(async () => {
    if (!admittedTurnAdoptionLifecycles.has(lifecycle)) {
      await lifecycle.onAdopted();
      run.operatorAuthority?.assertCurrent();
      admittedTurnAdoptionLifecycles.add(lifecycle);
      deferredHeartbeatStops.get(lifecycle)?.();
    }
  });

  admittingTurnAdoptionLifecycles.set(lifecycle, admission);
  try {
    await admission;
  } finally {
    admittingTurnAdoptionLifecycles.delete(lifecycle);
  }
}

export function completeFollowupRunLifecycle(
  run: FollowupLifecycleRun,
  disposition?: "consumed",
): void {
  run.steerPending?.settle(false);
  const lifecycle = run.turnAdoptionLifecycle;

  const finish = () => {
    if (!lifecycle || completedTurnAdoptionLifecycleCallbacks.has(lifecycle)) {
      return;
    }
    completedTurnAdoptionLifecycleCallbacks.add(lifecycle);
    // Async onAbandoned work must contain its own rejections; core guarantees a
    // non-rejecting promise. onSettled must still run after a synchronous throw.
    try {
      if (disposition !== "consumed" && !admittedTurnAdoptionLifecycles.has(lifecycle)) {
        lifecycle.onAbandoned?.();
      }
    } finally {
      lifecycle.onSettled?.();
    }
  };

  if (lifecycle && !completedTurnAdoptionLifecycles.has(lifecycle)) {
    deferredHeartbeatStops.get(lifecycle)?.();
    completedTurnAdoptionLifecycles.add(lifecycle);
  }

  const admission = lifecycle ? admittingTurnAdoptionLifecycles.get(lifecycle) : undefined;
  if (!admission) {
    finish();
    return;
  }
  // Completion closes future admission immediately, but the callback waits for
  // the in-flight admission attempt so adoption and abandonment cannot race.
  void admission.then(finish, finish).catch(() => {});
}
