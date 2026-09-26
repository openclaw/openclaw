// Settlement and rollback for claimed task suggestions and partial sessions.
import {
  ErrorCodes,
  errorShape,
  type TaskSuggestion,
  type TaskSuggestionsAcceptResult,
} from "../../../packages/gateway-protocol/src/index.js";
import { loadGatewaySessionEntryReadOnly } from "../session-utils.js";
import {
  abandonTaskSuggestionAcceptance,
  cancelTaskSuggestionAcceptance,
  completeTaskSuggestionAcceptance,
  getTaskSuggestion,
} from "../task-suggestion-registry.js";
import { sessionDeleteHandlers } from "./sessions-delete.js";
import type { GatewayRequestHandlerOptions, RespondFn } from "./types.js";

export type TaskSuggestionAcceptanceResult =
  | { ok: true; result: TaskSuggestionsAcceptResult }
  | { ok: false; error: NonNullable<Parameters<RespondFn>[2]> };

export function broadcastResolvedTaskSuggestion(
  context: GatewayRequestHandlerOptions["context"],
  suggestion: Pick<TaskSuggestion, "id" | "sessionKey" | "agentId">,
  resolution: "accepted" | "dismissed" | "expired",
): void {
  context.broadcast(
    "task.suggestion",
    { action: "resolved", taskId: suggestion.id, resolution },
    {
      dropIfSlow: true,
      sessionKeys: [suggestion.sessionKey],
      ...(suggestion.agentId ? { agentId: suggestion.agentId } : {}),
    },
  );
}

export function abandonSuggestedTaskAcceptance(
  taskId: string,
  options: GatewayRequestHandlerOptions,
): void {
  const suggestion = getTaskSuggestion(taskId);
  if (suggestion && abandonTaskSuggestionAcceptance(taskId)) {
    broadcastResolvedTaskSuggestion(options.context, suggestion, "expired");
  }
}

async function rollbackSuggestedTaskSession(params: {
  key: string;
  agentId?: string;
  options: GatewayRequestHandlerOptions;
}): Promise<boolean> {
  let deletionResponse: { ok: true; worktreePreserved: boolean } | { ok: false } | undefined;
  try {
    const deleteSession = sessionDeleteHandlers["sessions.delete"];
    if (!deleteSession) {
      return false;
    }
    await deleteSession({
      ...params.options,
      params: {
        key: params.key,
        ...(params.agentId ? { agentId: params.agentId } : {}),
        deleteTranscript: true,
        emitLifecycleHooks: false,
      },
      respond: (ok, payload) => {
        if (
          !ok ||
          !payload ||
          typeof payload !== "object" ||
          !("deleted" in payload) ||
          typeof payload.deleted !== "boolean"
        ) {
          deletionResponse = { ok: false };
          return;
        }
        deletionResponse = {
          ok: true,
          worktreePreserved:
            "worktreePreserved" in payload && payload.worktreePreserved !== undefined,
        };
      },
    });
  } catch {
    return false;
  }
  if (!deletionResponse?.ok || deletionResponse.worktreePreserved) {
    return false;
  }
  try {
    return !loadGatewaySessionEntryReadOnly(params.key, { agentId: params.agentId }).entry;
  } catch {
    return false;
  }
}

export async function failSuggestedTaskSession(params: {
  taskId: string;
  sessionKey: string;
  agentId: string;
  options: GatewayRequestHandlerOptions;
  error: NonNullable<Parameters<RespondFn>[2]>;
}): Promise<TaskSuggestionAcceptanceResult> {
  const rolledBack = await rollbackSuggestedTaskSession({
    key: params.sessionKey,
    agentId: params.agentId,
    options: params.options,
  });
  if (rolledBack) {
    return restoreSuggestedTaskClaim(params);
  }
  abandonSuggestedTaskAcceptance(params.taskId, params.options);
  return {
    ok: false,
    error: errorShape(
      ErrorCodes.UNAVAILABLE,
      `${params.error.message}; failed to roll back the partial suggested task session`,
    ),
  };
}

export function finishSuggestedTaskAcceptance(params: {
  taskId: string;
  sessionKey: string;
  suggestion: TaskSuggestion;
  options: GatewayRequestHandlerOptions;
}): TaskSuggestionAcceptanceResult {
  completeTaskSuggestionAcceptance(params.taskId, params.sessionKey);
  broadcastResolvedTaskSuggestion(params.options.context, params.suggestion, "accepted");
  return { ok: true, result: { taskId: params.taskId, key: params.sessionKey } };
}

export function restoreSuggestedTaskClaim(params: {
  taskId: string;
  options: GatewayRequestHandlerOptions;
  error: NonNullable<Parameters<RespondFn>[2]>;
}): TaskSuggestionAcceptanceResult {
  // Before session creation or after source-session delivery fails, only the
  // suggestion claim can be rolled back; never delete the source session.
  const restored = cancelTaskSuggestionAcceptance(params.taskId);
  if (restored) {
    params.options.context.broadcast(
      "task.suggestion",
      { action: "created", suggestion: restored },
      { dropIfSlow: true },
    );
  }
  return { ok: false, error: params.error };
}
