import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { createInternalHookEvent, triggerInternalHook } from "./internal-hooks.js";

export type EmitMessageSentHooksParams = {
  to: string;
  content: string;
  success: boolean;
  channelId: string;
  accountId?: string;
  conversationId?: string;
  sessionKey?: string;
  error?: string;
  messageId?: string;
};

export function emitMessageSentHooks(params: EmitMessageSentHooksParams): void {
  const hookRunner = getGlobalHookRunner();
  if (hookRunner?.hasHooks("message_sent")) {
    void hookRunner
      .runMessageSent(
        {
          to: params.to,
          content: params.content,
          success: params.success,
          ...(params.error ? { error: params.error } : {}),
        },
        {
          channelId: params.channelId,
          accountId: params.accountId,
          conversationId: params.conversationId ?? params.to,
        },
      )
      .catch(() => {});
  }

  if (!params.sessionKey) {
    return;
  }

  void triggerInternalHook(
    createInternalHookEvent("message", "sent", params.sessionKey, {
      to: params.to,
      content: params.content,
      success: params.success,
      ...(params.error ? { error: params.error } : {}),
      channelId: params.channelId,
      accountId: params.accountId,
      conversationId: params.conversationId ?? params.to,
      messageId: params.messageId,
    }),
  ).catch(() => {});
}
