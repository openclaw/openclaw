import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { AgentSelectionRequiredError } from "../../agents/agent-scope.js";
import { SessionMutationAuthorizationChangedError } from "../session-mutation-authorization-error.js";
import { formatForLog } from "../ws-log.js";
import { TalkRelayCapacityError } from "./relay-session-lifecycle.js";

/** Client errors omit Talk issues; legacy relay errors always report unavailable. */
export function talkRequestError(
  error: unknown,
  projection: "client" | "session" | "legacy-relay" = "client",
) {
  const classify = projection !== "legacy-relay";
  if (classify && error instanceof SessionMutationAuthorizationChangedError) {
    return error.error;
  }
  const message = formatForLog(error);
  // Typed so clients can report "busy" without parsing this message.
  if (classify && error instanceof TalkRelayCapacityError) {
    return errorShape(ErrorCodes.UNAVAILABLE, message, {
      retryable: true,
      details: { code: "TALK_SESSION_CAPACITY" },
    });
  }
  const invalidRequest = classify && error instanceof AgentSelectionRequiredError;
  return errorShape(
    invalidRequest ? ErrorCodes.INVALID_REQUEST : ErrorCodes.UNAVAILABLE,
    message,
    !invalidRequest && projection !== "client"
      ? { details: { talkIssue: { code: "realtime_unavailable", message, phase: "request" } } }
      : undefined,
  );
}
