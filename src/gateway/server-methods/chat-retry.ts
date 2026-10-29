import {
  ErrorCodes,
  errorShape,
  validateChatRetryParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { RUN_FAILURE_RETRY_SOURCE_TOOL } from "../../sessions/input-provenance.js";
import { SessionMutationAuthorizationChangedError } from "../session-mutation-authorization-error.js";
import { prepareChatHistorySessionRead } from "./chat-history-session-read.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

const METHOD = "chat.retry";

// Continue with the existing history rather than replaying a prompt whose tools
// may already have completed side effects.
const RETRY_MESSAGE =
  "Continue from where you stopped. Check which actions already completed before retrying anything.";

export const chatRetryHandlers: GatewayRequestHandlers = {
  /** Try again is an operator action, not a chat message: its input stays out of the chat view. */
  [METHOD]: async (invocation) => {
    const { params, respond, context, client, signal, sessionMutationAuthorization } = invocation;
    if (!assertValidParams(params, validateChatRetryParams, METHOD, respond)) {
      return;
    }
    let selection: Awaited<ReturnType<typeof prepareChatHistorySessionRead>>;
    try {
      selection = await prepareChatHistorySessionRead({
        context,
        client,
        respond,
        signal,
        sessionMutationAuthorization,
        method: METHOD,
        sessionKey: params.sessionKey,
        agentIdOverride: params.agentId,
      });
      if (!selection) {
        return;
      }
      const { entry } = selection;
      const { agentId, canonicalKey } = selection.selectedSession;
      // Only the latest terminal failure offers Try again; any newer run owns the session.
      if (
        !entry ||
        (params.sessionId !== undefined && entry.sessionId !== params.sessionId) ||
        entry.lastRunId !== params.runId ||
        entry.lifecycleRunId ||
        (entry.status !== "failed" && entry.status !== "timeout")
      ) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "This reply changed before it could be retried. Refresh the conversation and try again.",
          ),
        );
        return;
      }
      const { handleTrustedInternalChatSend } = await import("./chat-send-handler.js");
      invocation.sessionMutationCommitGuard?.();
      sessionMutationAuthorization?.assertCurrent();
      await handleTrustedInternalChatSend(
        {
          ...invocation,
          req: { ...invocation.req, method: "chat.send" },
          params: {
            sessionKey: canonicalKey,
            agentId,
            sessionId: entry.sessionId,
            message: RETRY_MESSAGE,
            idempotencyKey: params.idempotencyKey,
            deliver: false,
            suppressCommandInterpretation: true,
            systemInputProvenance: {
              kind: "internal_system",
              sourceTool: RUN_FAILURE_RETRY_SOURCE_TOOL,
              runId: params.runId,
            },
          },
        },
        undefined,
        { transcript: { display: false } },
      );
    } catch (error) {
      if (error instanceof SessionMutationAuthorizationChangedError) {
        respond(false, undefined, error.error);
        return;
      }
      throw error;
    } finally {
      selection?.release();
    }
  },
};
