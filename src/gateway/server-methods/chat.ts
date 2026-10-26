import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  validateChatInjectParams,
  validateChatToolTitlesParams,
  type ChatInjectParams,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  acquireSessionActorStorage,
  runWithSessionActorStorage,
} from "../../config/sessions/session-actor-storage-binding.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { chatHistoryHandlers } from "./chat-history-handler.js";
import { injectGatewayAssistantMessage } from "./chat-inject.js";
import { chatMessageGetHandlers } from "./chat-message-get-handler.js";
import { chatPendingInputsDismissHandlers } from "./chat-pending-inputs-dismiss-handler.js";
import { chatPredictionHandlers } from "./chat-prediction-handler.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

export const chatHandlers: GatewayRequestHandlers = {
  ...chatHistoryHandlers,
  ...chatMessageGetHandlers,
  ...chatPredictionHandlers,
  ...chatPendingInputsDismissHandlers,
  "chat.toolTitles": async ({ params, respond }) => {
    if (!assertValidParams(params, validateChatToolTitlesParams, "chat.toolTitles", respond)) {
      return;
    }
    // Keep the shipped disabled response until a versioned protocol removal;
    // older clients stop asking, while current clients read the tool call title.
    respond(true, { titles: {}, disabled: true });
  },
  "chat.inject": async (options) => {
    const { params, respond, sessionMutationCommitGuard } = options;
    if (!assertValidParams(params, validateChatInjectParams, "chat.inject", respond)) {
      return;
    }
    if (!isIncognitoSessionKey(params.sessionKey)) {
      return injectChat(options, params);
    }
    const assertCurrent = () => sessionMutationCommitGuard?.();
    const binding = await acquireSessionActorStorage(
      { sessionKey: params.sessionKey, agentId: normalizeOptionalString(params.agentId) },
      {
        lifetime: { assertCurrent, assertReadable: assertCurrent },
        authority: { assertCurrent, authorize: assertCurrent },
      },
    );
    if (!binding) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "session not found"));
      return;
    }
    try {
      await runWithSessionActorStorage(binding, () => injectChat(options, params));
    } finally {
      await binding.actor.release();
    }
  },
};

async function injectChat(
  { respond, context, sessionMutationCommitGuard }: GatewayRequestHandlerOptions,
  params: ChatInjectParams,
): Promise<void> {
  const result = await injectGatewayAssistantMessage(
    context,
    {
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      message: params.message,
      label: params.label,
    },
    sessionMutationCommitGuard,
  );
  if (result.ok) {
    respond(true, { ok: true, messageId: result.value.messageId });
  } else {
    respond(false, undefined, result.error);
  }
}
