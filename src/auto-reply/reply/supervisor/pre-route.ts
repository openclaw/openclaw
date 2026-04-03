import type {
  SupervisorAction,
  SupervisorEvent,
  SupervisorPreRouteResult,
  SupervisorTaskState,
} from "./types.js";

function resolveControlAction(text: string): SupervisorAction | undefined {
  const normalized = text.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (["stop", "cancel", "nevermind", "never mind", "算了", "取消", "停止"].includes(normalized)) {
    return "abort_and_replace";
  }
  if (["continue", "继续"].includes(normalized)) {
    return "continue";
  }
  return undefined;
}

export function preRouteSupervisorEvent(params: {
  event: SupervisorEvent;
  taskState: SupervisorTaskState;
}): SupervisorPreRouteResult {
  const text =
    typeof params.event.payload.text === "string" ? params.event.payload.text.trim() : "";
  const controlAction = resolveControlAction(text);
  if (controlAction) {
    return {
      kind: "deterministic",
      relation: "same_task_control",
      action: controlAction,
      reason: "explicit_control_signal",
    };
  }
  if (params.taskState.interruptibility === "atomic") {
    return {
      kind: "deterministic",
      relation: "background_relevant",
      action: "defer",
      reason: "atomic_phase_defers_non_control_events",
    };
  }
  return {
    kind: "model",
    reason: "requires_relation_classification",
  };
}
