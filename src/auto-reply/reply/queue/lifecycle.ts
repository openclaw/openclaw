import { defaultRuntime } from "../../../runtime.js";
import { completeSessionControllerSourceLifecycle } from "../../../sessions/session-controller.mailbox-source.js";
import { submitSessionControllerInput } from "../../../sessions/session-controller.mailbox.js";
import type { ReplyOperationRunState } from "../reply-operation-run-state.js";
import {
  startFollowupRunPreAdoptionHeartbeatWithCustody,
  updateFollowupRetryHeartbeatsWithCustody,
} from "./pre-adoption-heartbeat.js";
import type { FollowupRun } from "./types.js";

type FollowupLifecycleSource = Pick<
  FollowupRun,
  "operatorAuthority" | "turnAdoptionLifecycle" | "userTurnTranscriptRecorder" | "controllerClaim"
> & { controllerInput: NonNullable<FollowupRun["controllerInput"]> };

function custody(run: FollowupRun | FollowupLifecycleSource) {
  if (run.controllerClaim) {
    return run.controllerClaim.custody;
  }
  const input =
    "run" in run
      ? (run.controllerInput ??
        submitSessionControllerInput(run.run.sessionKey ?? run.run.sessionId, run, {
          mode: "followup",
        }))
      : run.controllerInput;
  return input.custody;
}

// Native consumption can finish without adoption; disposal alone cannot infer that outcome.
const abandonedDeliveryCorrelations = new WeakMap<ReturnType<typeof custody>, () => void>();

function retainQueuedDeliveryCorrelations(
  run: FollowupRun,
  state: ReturnType<typeof custody>,
): void {
  if (!run.deliveryCorrelations?.length) {
    return;
  }
  const abandon: Array<() => void> = [];
  run.deliveryCorrelations = run.deliveryCorrelations.map((correlation) => {
    let pending = true;
    abandon.push(() => {
      if (!pending) {
        return;
      }
      pending = false;
      try {
        const end = correlation.begin();
        if (typeof end === "function") {
          end({ visibleReplySent: false, failed: true });
        }
      } catch (error) {
        defaultRuntime.error?.(
          `followup queue: delivery correlation cleanup failed: ${String(error)}`,
        );
      }
    });
    return {
      ...correlation,
      begin: () => {
        pending = false;
        const end = correlation.begin();
        if (typeof end !== "function") {
          return end;
        }
        return (settlement: Parameters<typeof end>[0]) => {
          // A retry hands ownership back; a final delivery outcome must not be repeated by Stop.
          pending = settlement === undefined;
          end(settlement);
        };
      },
    };
  });
  abandonedDeliveryCorrelations.set(state, () => {
    for (const notify of abandon) {
      notify();
    }
  });
  const disposeSource = state.disposeSource;
  state.disposeSource = () => {
    const notify = abandonedDeliveryCorrelations.get(state);
    abandonedDeliveryCorrelations.delete(state);
    try {
      disposeSource?.();
    } finally {
      if (!state.adopted) {
        notify?.();
      }
    }
  };
}

export function updateFollowupRetryHeartbeats(
  error: unknown,
  sources: readonly FollowupRun[],
): void {
  updateFollowupRetryHeartbeatsWithCustody(error, sources, custody);
}

export function startFollowupRunPreAdoptionHeartbeat(
  run: FollowupRun,
  abortSignal?: AbortSignal,
): (() => void) | undefined {
  return startFollowupRunPreAdoptionHeartbeatWithCustody(run, () => custody(run), abortSignal);
}

export function markFollowupRunEnqueued(run: FollowupRun): boolean {
  const state = custody(run);
  const authority = run.operatorAuthority;
  authority?.signal?.throwIfAborted();
  authority?.assertCurrent();
  if (!state.enqueued) {
    // Deferral publishes the source and can synchronously wake its RPC waiters.
    state.enqueued = true;
    try {
      if (run.turnAdoptionLifecycle?.onDeferred?.() === false) {
        state.enqueued = false;
        return false;
      }
      state.releaseAuthority = authority?.retain?.();
    } catch (error) {
      state.enqueued = false;
      completeFollowupRunLifecycle(run);
      throw error;
    }
    retainQueuedDeliveryCorrelations(run, state);
    startFollowupRunPreAdoptionHeartbeat(run);
  }
  return true;
}
export function retireFollowupRunCancellation(run: FollowupRun): void {
  const state = custody(run);
  if (state.cancellationRetired) {
    return;
  }
  state.cancellationRetired = true;
  run.turnAdoptionLifecycle?.onCancellationRetired?.();
}
export async function admitFollowupRunLifecycle(
  run: FollowupRun | FollowupLifecycleSource,
): Promise<void> {
  const state = custody(run);
  run.operatorAuthority?.assertCurrent();
  if (state.adopted) {
    return;
  }
  if (state.adopting) {
    return await state.adopting;
  }
  if (state.completed) {
    throw new Error("Input completed before source adoption");
  }
  const admission = Promise.resolve().then(async () => {
    await run.turnAdoptionLifecycle?.onAdopted();
    // A successful custody callback commits before the post-await authority check.
    state.adopted = true;
    state.failure = undefined;
    state.stopHeartbeat?.();
    run.operatorAuthority?.assertCurrent();
  });
  state.adopting = admission;
  try {
    await admission;
  } catch (error) {
    state.failure = error;
    throw error;
  } finally {
    state.adopting = undefined;
  }
}

/** Adapter registers source identity before the canonical custody owner settles it. */
export function completeFollowupRunLifecycle(
  run: FollowupRun | FollowupLifecycleSource,
  disposition?: "consumed",
): void {
  const state = custody(run);
  if (!state.completed && disposition === "consumed") {
    abandonedDeliveryCorrelations.delete(state);
  }
  completeSessionControllerSourceLifecycle(run, state, disposition);
}

/** A policy refusal consumes transport custody without granting execution custody. */
export async function refuseCollaborativeSteering(
  run: FollowupRun | FollowupLifecycleSource,
  state: ReplyOperationRunState | undefined,
  consumeParked?: () => void,
): Promise<void> {
  if (state) {
    state.admission = { status: "skipped", reason: "collaborative-steering-disabled" };
  }
  const recorder = run.userTurnTranscriptRecorder;
  recorder?.markBlocked();
  try {
    recorder?.finishPendingInput?.("cancelled");
    await recorder?.waitForPendingInputSettlement?.();
    await admitFollowupRunLifecycle(run);
  } finally {
    // Abandonment reopens ingress for replay; this input has a terminal policy decision.
    if (consumeParked) {
      consumeParked();
    } else {
      completeFollowupRunLifecycle(run, "consumed");
    }
  }
}
