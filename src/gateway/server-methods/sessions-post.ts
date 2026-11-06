import {
  ErrorCodes,
  errorShape,
  validateSessionsPostParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { getGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { composeSessionSourceAssertion } from "../../config/sessions/session-source-authority.js";
import { runWithoutOwnedSessionTranscriptWrites } from "../../config/sessions/transcript-write-context-store.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { injectGatewayAssistantMessage } from "./chat-inject.js";
import type { GatewayRequestHandler } from "./types.js";
import { assertValidParams } from "./validation.js";

/** Canonical transcript injection, not notification, steering, or turn admission. */
export const handleSessionPost: GatewayRequestHandler = async (options) => {
  const { params, respond, context, sessionMutationCommitGuard, sessionMutationAuthorization } =
    options;
  if (!assertValidParams(params, validateSessionsPostParams, "sessions.post", respond)) {
    return;
  }
  if (isIncognitoSessionKey(params.sessionKey)) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "Passive posts require a persistent session."),
    );
    return;
  }
  const sourceSessionKey = getGatewayToolCallerIdentity()?.sessionKey;
  const result = await runWithoutOwnedSessionTranscriptWrites(() =>
    injectGatewayAssistantMessage(
      context,
      {
        sessionKey: params.sessionKey,
        agentId: params.agentId,
        expectedSessionId: params.expectedSessionId,
        message: params.message,
        literal: true,
        label: sourceSessionKey ? "Post from " + sourceSessionKey : "Session post",
        idempotencyKey: JSON.stringify([
          "session-post",
          sourceSessionKey ?? null,
          params.idempotencyKey,
        ]),
        inputProvenance: {
          kind: "inter_session",
          sourceTool: "sessions_send",
          ...(sourceSessionKey ? { sourceSessionKey } : {}),
        },
      },
      composeSessionSourceAssertion([
        sessionMutationCommitGuard,
        sessionMutationAuthorization?.assertCurrent,
      ]),
    ),
  );
  if (!result.ok) {
    respond(false, undefined, result.error);
    return;
  }
  respond(true, {
    status: "posted",
    sessionKey: params.sessionKey,
    sessionId: params.expectedSessionId,
    messageId: result.value.messageId,
    replayed: result.value.replayed === true,
    ...(sourceSessionKey ? { sourceSessionKey } : {}),
  });
};
