import type { JsonValue, TaskFlowRecord } from "./task-flow-registry.types.js";

export type TaskFlowGuidance = {
  code: "retry_available" | "user_action_required";
  retryable: boolean;
  needsUserAction: boolean;
  summary: string;
};

function isJsonObject(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function getCompletion(flow: Pick<TaskFlowRecord, "stateJson">): Record<string, JsonValue> | null {
  if (!isJsonObject(flow.stateJson)) {
    return null;
  }
  const completion = flow.stateJson.completion;
  return isJsonObject(completion) ? completion : null;
}

export function getTaskFlowGuidance(
  flow: Pick<TaskFlowRecord, "syncMode" | "status" | "blockedTaskId" | "stateJson">,
): TaskFlowGuidance | undefined {
  if (flow.syncMode !== "managed") {
    return undefined;
  }
  const completion = getCompletion(flow);
  if (
    flow.status === "blocked" ||
    completion?.terminalOutcome === "blocked" ||
    (typeof flow.blockedTaskId === "string" && flow.blockedTaskId.trim())
  ) {
    return {
      code: "user_action_required",
      retryable: true,
      needsUserAction: true,
      summary: "Needs user action before retrying.",
    };
  }
  if (flow.status === "failed" || flow.status === "lost") {
    return {
      code: "retry_available",
      retryable: true,
      needsUserAction: false,
      summary: "Retry available.",
    };
  }
  return undefined;
}
