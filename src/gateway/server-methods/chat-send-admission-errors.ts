import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import { GATEWAY_RESTART_UNAVAILABLE_REASON } from "../../../packages/gateway-protocol/src/restart-unavailable.js";
import { renderStorageFailureSummary } from "../../agents/failover/assistant-request-failure-copy.js";
import { isAgentRunRestartAbortReason } from "../../agents/run-termination.js";
import { SessionGoalOperationError } from "../../config/sessions/goals-operations.js";
import { SESSION_ROUTING_CHANGED_ERROR_REASON } from "../../config/sessions/main-session.js";
import { isSessionTranscriptProjectionUnavailableError } from "../../config/sessions/session-transcript-projection-error.js";
import { classifyGatewayStorageFailure } from "../../infra/sqlite-error-diagnostics.js";
import { hasSqliteWorkerOutcomeUnknown } from "../../infra/sqlite-worker-contract.js";
import { isGatewayRestartDrainError } from "../../process/gateway-work-admission.js";
import { errorShapeFromError } from "../error-shape.js";
import { formatForLog } from "../ws-log.js";
import { ACTIVE_LEAF_CHANGED_ERROR_REASON } from "./chat-send-active-leaf.js";
import { SESSION_SETTINGS_CHANGED_ERROR_REASON } from "./chat-send-session-settings.js";
import { respondError } from "./response.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

export function resolveChatSendStorageErrorMessage(error: unknown): string | undefined {
  return renderStorageFailureSummary(classifyGatewayStorageFailure(error));
}

export function respondChatSessionRoutingChanged(respond: GatewayRequestHandlerOptions["respond"]) {
  respondError(respond, ErrorCodes.INVALID_REQUEST, "session routing changed; review and retry", {
    details: { reason: SESSION_ROUTING_CHANGED_ERROR_REASON },
  });
}

export function respondChatSendAdmissionError(
  error: unknown,
  respond: GatewayRequestHandlerOptions["respond"],
  onStorageError?: (message: string) => void,
): void {
  if (isAgentRunRestartAbortReason(error) || isGatewayRestartDrainError(error)) {
    return respondError(
      respond,
      ErrorCodes.UNAVAILABLE,
      "Gateway is restarting; retry after reconnecting",
      {
        retryable: true,
        details: { reason: GATEWAY_RESTART_UNAVAILABLE_REASON },
      },
    );
  }
  if (error instanceof SessionGoalOperationError) {
    return respondError(respond, ErrorCodes.INVALID_REQUEST, error.message, {
      details: { reason: `goal-${error.code}` },
    });
  }
  const reason = error instanceof Error ? error.message : undefined;
  if (reason === "goal-session-busy") {
    return respondError(
      respond,
      ErrorCodes.UNAVAILABLE,
      "This session still has active or queued work. Wait for it to finish, then retry the Goal.",
      { retryable: true, details: { reason: "goal-session-busy" } },
    );
  }
  if (reason === SESSION_ROUTING_CHANGED_ERROR_REASON) {
    return respondChatSessionRoutingChanged(respond);
  }
  if (
    reason === ACTIVE_LEAF_CHANGED_ERROR_REASON ||
    reason === SESSION_SETTINGS_CHANGED_ERROR_REASON
  ) {
    return respondError(
      respond,
      ErrorCodes.INVALID_REQUEST,
      reason === ACTIVE_LEAF_CHANGED_ERROR_REASON
        ? "active branch changed; review and retry"
        : "Session settings changed before send. Retry.",
      { details: { reason } },
    );
  }
  if (isSessionTranscriptProjectionUnavailableError(error)) {
    return respondError(
      respond,
      ErrorCodes.UNAVAILABLE,
      "session transcript is rebuilding; retry shortly",
      {
        details: { method: "chat.send" },
        retryable: true,
        retryAfterMs: 250,
      },
    );
  }
  const storageMessage = resolveChatSendStorageErrorMessage(error);
  const failure = errorShapeFromError(
    storageMessage ? ErrorCodes.UNAVAILABLE : ErrorCodes.INVALID_REQUEST,
    error,
    { message: storageMessage ?? formatForLog(error) },
  );
  respond(false, undefined, failure);
  // Other admission failures retain the RPC-only contract, including unclassified refusals.
  if (storageMessage !== undefined || hasSqliteWorkerOutcomeUnknown(error)) {
    onStorageError?.(failure.message);
  }
}
