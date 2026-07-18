/** Exclusive-channel update handover state machine. */

type UpdateHandoverPhase =
  | "starting"
  | "internal-healthy"
  | "old-paused"
  | "new-active"
  | "confirmed"
  | "completed"
  | "rolling-back"
  | "rolled-back";

type UpdateHandoverEvent =
  | "internal-health-passed"
  | "old-channels-paused"
  | "new-channels-started"
  | "delivery-confirmed"
  | "human-confirmed"
  | "confirmation-timeout"
  | "health-failed"
  | "rollback-restored"
  | "complete";

export type UpdateConfirmationTier = "delivery" | "human";

type UpdateHandoverState = {
  phase: UpdateHandoverPhase;
  confirmationTier: UpdateConfirmationTier;
};

function advanceUpdateHandover(
  state: UpdateHandoverState,
  event: UpdateHandoverEvent,
): UpdateHandoverState {
  if (event === "health-failed" && (state.phase === "starting" || state.phase === "new-active")) {
    return { ...state, phase: "rolling-back" };
  }
  if (
    event === "confirmation-timeout" &&
    state.confirmationTier === "human" &&
    state.phase === "new-active"
  ) {
    return { ...state, phase: "rolling-back" };
  }
  if (event === "rollback-restored" && state.phase === "rolling-back") {
    return { ...state, phase: "rolled-back" };
  }
  const expected: Partial<Record<UpdateHandoverPhase, UpdateHandoverEvent>> = {
    starting: "internal-health-passed",
    "internal-healthy": "old-channels-paused",
    "old-paused": "new-channels-started",
    "new-active": state.confirmationTier === "human" ? "human-confirmed" : "delivery-confirmed",
    confirmed: "complete",
  };
  if (expected[state.phase] !== event) {
    throw new Error(`Invalid update handover transition: ${state.phase} + ${event}`);
  }
  const next: Partial<Record<UpdateHandoverPhase, UpdateHandoverPhase>> = {
    starting: "internal-healthy",
    "internal-healthy": "old-paused",
    "old-paused": "new-active",
    "new-active": "confirmed",
    confirmed: "completed",
  };
  return { ...state, phase: next[state.phase] as UpdateHandoverPhase };
}

export async function runUpdateHandover(params: {
  confirmationTier: UpdateConfirmationTier;
  waitForInternalHealth: () => Promise<boolean>;
  pauseOldChannels: () => Promise<void>;
  startNewChannels: () => Promise<void>;
  confirmDelivery: () => Promise<boolean>;
  confirmHumanReply: () => Promise<boolean>;
  stopNewChannels: () => Promise<void>;
  restorePrevious: () => Promise<void>;
  resumeOldChannels: () => Promise<void>;
  onPhase?: (phase: UpdateHandoverPhase) => Promise<void> | void;
}): Promise<UpdateHandoverState> {
  let state: UpdateHandoverState = { phase: "starting", confirmationTier: params.confirmationTier };
  const transition = async (event: UpdateHandoverEvent) => {
    state = advanceUpdateHandover(state, event);
    await params.onPhase?.(state.phase);
  };
  if (!(await params.waitForInternalHealth())) {
    await transition("health-failed");
  } else {
    await transition("internal-health-passed");
    await params.pauseOldChannels();
    await transition("old-channels-paused");
    await params.startNewChannels();
    await transition("new-channels-started");
    const confirmed =
      params.confirmationTier === "human"
        ? await params.confirmHumanReply()
        : await params.confirmDelivery();
    if (confirmed) {
      await transition(
        params.confirmationTier === "human" ? "human-confirmed" : "delivery-confirmed",
      );
      await transition("complete");
      return state;
    }
    if (params.confirmationTier === "delivery") {
      await transition("health-failed");
    } else {
      await transition("confirmation-timeout");
    }
  }
  await params.stopNewChannels();
  await params.restorePrevious();
  await params.resumeOldChannels();
  await transition("rollback-restored");
  return state;
}
