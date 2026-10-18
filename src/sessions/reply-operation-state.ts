/** Synchronous turn lifecycle state; attempts, authority and settlement belong to its operation. */
export type ReplyOperationActivePhase =
  | "queued"
  | "waiting_for_deferred_maintenance"
  | "waiting_for_global_lane"
  | "preflight_compacting"
  | "memory_flushing"
  | "running";

export type ReplyOperationPhase =
  | ReplyOperationActivePhase
  | "completed"
  | "yielded"
  | "failed"
  | "aborted";
export type ReplyOperationResult =
  | { kind: "completed" }
  /** The backend ended its own turn to await a continuation; recorded when the turn settles. */
  | { kind: "yielded" }
  | {
      kind: "failed";
      code:
        | "gateway_draining"
        | "command_lane_cleared"
        | "aborted_by_user"
        | "session_corruption_reset"
        | "run_stalled"
        | "run_failed";
      cause?: unknown;
    }
  | {
      kind: "aborted";
      code: "aborted_by_user" | "aborted_for_restart" | "aborted_for_supersession";
    };

export type ReplyOperationState = Readonly<{
  phase: ReplyOperationPhase;
  phaseBeforeGlobalLaneWait?: "queued" | "running";
  phaseBeforeMaintenanceWait?: "queued" | "running";
  result: ReplyOperationResult | null;
  cleared: boolean;
  abortFrozen: boolean;
}>;

export type ReplyOperationEvent =
  | { type: "phase"; phase: ReplyOperationActivePhase }
  | { type: "maintenance-wait" | "maintenance-ready" | "lane-wait" | "lane-ready" }
  | { type: "freeze" | "clear" | "yield" }
  | { type: "result"; result: ReplyOperationResult };

export type ReplyOperationEffect =
  | "activity"
  | "maintenance-wait"
  | "maintenance-ready"
  | "lane-wait"
  | "lane-ready";

export function initialReplyOperationState(): ReplyOperationState {
  return {
    phase: "queued",
    result: null,
    cleared: false,
    abortFrozen: false,
  };
}

/** No effects run here; an exact operation applies the returned effects after installing state. */
export function transitionReplyOperation(
  state: ReplyOperationState,
  event: ReplyOperationEvent,
): { state: ReplyOperationState; effects: readonly ReplyOperationEffect[] } {
  const unchanged = { state, effects: [] };
  // A recorded yield closes the phase without settling: the result arrives at settlement.
  const active = state.result === null && !state.cleared && state.phase !== "yielded";
  switch (event.type) {
    case "clear":
      return { state: { ...state, cleared: true }, effects: [] };
    case "freeze":
      return { state: { ...state, abortFrozen: true }, effects: [] };
    case "yield":
      return active ? { state: { ...state, phase: "yielded" }, effects: ["activity"] } : unchanged;
    case "result":
      return state.result
        ? unchanged
        : {
            state: { ...state, result: event.result, phase: event.result.kind },
            effects: ["activity"],
          };
    case "phase":
      return active
        ? { state: { ...state, phase: event.phase }, effects: ["activity"] }
        : unchanged;
    case "maintenance-wait":
      return active && (state.phase === "queued" || state.phase === "running")
        ? {
            state: {
              ...state,
              phaseBeforeMaintenanceWait: state.phase,
              phase: "waiting_for_deferred_maintenance",
            },
            effects: [event.type],
          }
        : unchanged;
    case "maintenance-ready":
      return active && state.phase === "waiting_for_deferred_maintenance"
        ? {
            state: {
              ...state,
              phase: state.phaseBeforeMaintenanceWait ?? "queued",
              phaseBeforeMaintenanceWait: undefined,
            },
            effects: [event.type],
          }
        : unchanged;
    case "lane-wait":
      return active && (state.phase === "queued" || state.phase === "running")
        ? {
            state: {
              ...state,
              phaseBeforeGlobalLaneWait: state.phase,
              phase: "waiting_for_global_lane",
            },
            effects: [event.type],
          }
        : unchanged;
    case "lane-ready":
      return active && state.phase === "waiting_for_global_lane"
        ? {
            state: {
              ...state,
              phase: state.phaseBeforeGlobalLaneWait ?? "queued",
              phaseBeforeGlobalLaneWait: undefined,
            },
            effects: [event.type],
          }
        : unchanged;
  }
  return event satisfies never;
}
