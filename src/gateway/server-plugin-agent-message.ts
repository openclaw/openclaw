import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import type { RuntimeAgentMessage, RuntimeAgentMessageResult } from "../plugins/runtime/types.js";
import { injectAssistantMessageWithHumanMentions } from "./assistant-human-mentions.js";
import { sanitizeChatSendMessageInput } from "./chat-input-sanitize.js";
import { normalizeChatHumanMentions } from "./server-methods/chat-human-mentions.js";
import { injectGatewayAssistantMessage } from "./server-methods/chat-inject.js";
import type { GatewayContextResolver } from "./server-methods/types.js";
import { runWithInProcessGatewaySessionMutation } from "./server-plugin-in-process-dispatch.js";
import { canTrustedOfficialPluginRequestScopes } from "./server-plugin-subagent-runtime.js";

/**
 * Append one plugin-written agent message, without a model run, to a session the bound
 * caller may write. The caller is the Inbox sender; mention policy stays with the Inbox.
 */
export async function appendTrustedPluginAgentMessage(
  params: RuntimeAgentMessage,
  resolveGatewayContext?: GatewayContextResolver,
): Promise<RuntimeAgentMessageResult> {
  const scope = getPluginRuntimeGatewayRequestScope();
  if (!canTrustedOfficialPluginRequestScopes(scope ?? {})) {
    throw new Error("Agent messages are only available to bundled or trusted official plugins.");
  }
  // Only an authenticated person's request can name a sender; background work cannot.
  const senderProfileId = scope?.client?.authenticatedUserProfile?.profileId;
  if (!senderProfileId) {
    throw new Error("Agent messages require a signed-in caller.");
  }
  const idempotencyKey = params.idempotencyKey.trim();
  if (!idempotencyKey) {
    throw new Error("An agent message needs a stable idempotency key.");
  }
  // Normalize like typed chat input, so plugin text with stored user content still mentions.
  const sanitized = sanitizeChatSendMessageInput(params.text);
  const text = sanitized.ok ? sanitized.message.trim() : "";
  if (!sanitized.ok || !text) {
    throw new Error(sanitized.ok ? "An agent message needs text." : sanitized.error);
  }
  const normalized = normalizeChatHumanMentions(params.text, params.mentions, sanitized.message);
  if (!normalized.ok) {
    throw new Error(normalized.error);
  }
  const mentions = normalized.value;
  return await runWithInProcessGatewaySessionMutation(
    { sessionKey: params.sessionKey, agentId: params.agentId, resolveGatewayContext },
    async (assertCurrent, context) => {
      const target = { sessionKey: params.sessionKey, agentId: params.agentId };
      const result = mentions
        ? await injectAssistantMessageWithHumanMentions(
            context,
            {
              ...target,
              text,
              mentions,
              onBehalfOfProfileId: senderProfileId,
              idempotencyKey,
            },
            assertCurrent,
          )
        : await injectGatewayAssistantMessage(
            context,
            {
              ...target,
              message: text,
              idempotencyKey: `assistant-message:${idempotencyKey}`,
              literal: true,
            },
            assertCurrent,
          );
      if (!result.ok) {
        throw new Error(result.error.message);
      }
      return { messageId: result.value.messageId, replayed: result.value.replayed === true };
    },
  );
}
