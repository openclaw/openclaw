import { fireAndForgetHook } from "../../hooks/fire-and-forget.js";
import { createInternalHookEvent, triggerInternalHook } from "../../hooks/internal-hooks.js";
import {
  buildCanonicalSentMessageHookContext,
  toInternalMessageSentContext,
  toPluginMessageContext,
  toPluginMessageSentEvent,
} from "../../hooks/message-hook-mappers.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import type { DeliveryMirror } from "./mirror.js";
import type { PreparedOutboundBatch } from "./prepared-batch.js";
import type { OutboundSessionContext } from "./session-context.js";

const log = createSubsystemLogger("outbound/message-sent-hook");

export type MessageSentEvent = {
  success: boolean;
  content: string;
  error?: string;
  messageId?: string;
};

/** Creates a best-effort emitter shared by direct and inbound-turn delivery owners. */
export function createMessageSentEmitter(params: {
  hookRunner: ReturnType<typeof getGlobalHookRunner>;
  channel: string;
  to: string;
  accountId?: string;
  sessionKeyForInternalHooks?: string;
  runId?: string;
  isGroup?: boolean;
  groupId?: string;
  logPrefix: string;
}): { emitMessageSent: (event: MessageSentEvent) => void; hasMessageSentHooks: boolean } {
  const hasMessageSentHooks = params.hookRunner?.hasHooks("message_sent") ?? false;
  const canEmitInternalHook = Boolean(params.sessionKeyForInternalHooks);
  const emitMessageSent = (event: MessageSentEvent) => {
    if (!hasMessageSentHooks && !canEmitInternalHook) {
      return;
    }
    const canonical = buildCanonicalSentMessageHookContext({
      to: params.to,
      content: event.content,
      success: event.success,
      error: event.error,
      channelId: params.channel,
      accountId: params.accountId,
      conversationId: params.to,
      // Reuse the canonical runtime session key for plugin/internal correlation; policy keys
      // describe the delivery target and must never leak into this lifecycle identity.
      sessionKey: params.sessionKeyForInternalHooks,
      runId: params.runId,
      messageId: event.messageId,
      isGroup: params.isGroup,
      groupId: params.groupId,
    });
    if (hasMessageSentHooks) {
      fireAndForgetHook(
        params.hookRunner!.runMessageSent(
          toPluginMessageSentEvent(canonical),
          toPluginMessageContext(canonical),
        ),
        `${params.logPrefix}: message_sent plugin hook failed`,
        (message) => {
          log.warn(message);
        },
      );
    }
    if (!canEmitInternalHook) {
      return;
    }
    fireAndForgetHook(
      triggerInternalHook(
        createInternalHookEvent(
          "message",
          "sent",
          params.sessionKeyForInternalHooks!,
          toInternalMessageSentContext(canonical),
        ),
      ),
      `${params.logPrefix}: message:sent internal hook failed`,
      (message) => {
        log.warn(message);
      },
    );
  };
  return { emitMessageSent, hasMessageSentHooks };
}

/** Bind outbound hook correlation to the accepted delivery's runtime session. */
export function createOutboundMessageSentEmitter(
  params: {
    channel: string;
    to: string;
    accountId?: string;
    mirror?: DeliveryMirror;
    session?: OutboundSessionContext;
    preparedBatch?: PreparedOutboundBatch;
  },
  logPrefix: string,
) {
  const sessionKeyForInternalHooks = params.mirror?.sessionKey ?? params.session?.key;
  return {
    ...createMessageSentEmitter({
      hookRunner: getGlobalHookRunner(),
      channel: params.channel,
      to: params.to,
      accountId: params.accountId,
      sessionKeyForInternalHooks,
      isGroup: params.mirror?.isGroup,
      groupId: params.mirror?.groupId,
      runId: params.preparedBatch?.runId,
      logPrefix,
    }),
    sessionKeyForInternalHooks,
  };
}
