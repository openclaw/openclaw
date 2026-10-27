import {
  ErrorCodes,
  errorShape,
  GatewayErrorDetailCodes,
  validateChatPendingInputsDismissParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { CHAT_INPUT_RUN_ID_MAX_CHARS } from "../../../packages/gateway-protocol/src/schema/chat-history-constants.js";
import { dismissRetiredSessionPendingInputs } from "../../config/sessions/session-pending-input-withdrawal.js";
import { SessionMutationAuthorizationChangedError } from "../session-mutation-authorization-error.js";
import { prepareChatHistorySessionRead } from "./chat-history-session-read.js";
import { emitSessionsChanged } from "./session-change-event.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

const METHOD = "chat.pendingInputs.dismiss";

export const chatPendingInputsDismissHandlers: GatewayRequestHandlers = {
  [METHOD]: async ({
    params,
    respond,
    context,
    client,
    signal,
    sessionMutationAuthorization,
    sessionAccessAuthority,
  }) => {
    if (!assertValidParams(params, validateChatPendingInputsDismissParams, METHOD, respond)) {
      return;
    }
    if (!sessionAccessAuthority) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.FORBIDDEN,
          "Dismissing pending inputs requires session write access.",
        ),
      );
      return;
    }
    const target = sessionAccessAuthority.target;
    const staleTarget = () =>
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "The conversation changed before pending inputs were dismissed; reload and retry.",
        ),
      );
    if (params.sessionId !== target.sessionId) {
      staleTarget();
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
      const { agentId, canonicalKey, storePath } = selection.selectedSession;
      if (
        agentId !== target.agentId ||
        canonicalKey !== target.sessionKey ||
        selection.entry?.sessionId !== target.sessionId
      ) {
        staleTarget();
        return;
      }
      const outcome = await dismissRetiredSessionPendingInputs(
        { agentId, sessionKey: canonicalKey, sessionId: target.sessionId, storePath },
        params.inputIds,
        () => {
          signal?.throwIfAborted();
          sessionAccessAuthority.assertCurrent();
        },
      );
      if (outcome.kind === "stale") {
        staleTarget();
        return;
      }
      if (outcome.kind === "active") {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "Only interrupted or cancelled pending inputs can be dismissed; queued and running inputs stay in place.",
            {
              details: {
                code: GatewayErrorDetailCodes.PENDING_INPUT_NOT_RETIRED,
                inputIds: outcome.inputIds,
              },
            },
          ),
        );
        return;
      }
      if (outcome.inputIds.length) {
        emitSessionsChanged(
          context,
          {
            sessionKey: canonicalKey,
            sessionId: target.sessionId,
            agentId,
            reason: "agent.input.settled",
          },
          { accessChanged: false },
        );
      }
      respond(true, {
        dismissedIds: outcome.inputIds,
        runIds: outcome.runIds.filter((runId) => runId.length <= CHAT_INPUT_RUN_ID_MAX_CHARS),
        missingIds: outcome.missingIds,
      });
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
