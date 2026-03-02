import { randomUUID } from "node:crypto";
import { dispatchInboundMessageWithDispatcher } from "../auto-reply/dispatch.js";
import { normalizeChannelId } from "../channels/plugins/index.js";
import { createReplyPrefixOptions } from "../channels/reply-prefix.js";
import { loadSessionEntry } from "../gateway/session-utils.js";
import { logWarn } from "../logger.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import { deliveryContextFromSession } from "../utils/delivery-context.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel.js";
import { shouldUseSessionScopedHeartbeatWake } from "./heartbeat-reason.js";

export async function triggerSessionEventRun(params: {
  sessionKey: string;
  source: string;
  agentId?: string;
}): Promise<boolean> {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    return false;
  }

  const { cfg, canonicalKey, entry } = loadSessionEntry(sessionKey);
  if (!shouldUseSessionScopedHeartbeatWake(canonicalKey)) {
    return false;
  }

  const delivery = deliveryContextFromSession(entry);
  const originatingChannel = delivery?.channel
    ? (normalizeChannelId(delivery.channel) ?? delivery.channel)
    : undefined;
  const originatingTo = delivery?.to?.trim() || undefined;
  const resolvedAgentId = params.agentId ?? resolveAgentIdFromSessionKey(canonicalKey);
  const source = params.source.trim() || "system-event";
  const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
    cfg,
    agentId: resolvedAgentId,
    channel: originatingChannel,
    accountId: delivery?.accountId,
  });

  await dispatchInboundMessageWithDispatcher({
    cfg,
    ctx: {
      Body: "",
      RawBody: "",
      CommandBody: "",
      BodyForAgent: "",
      BodyForCommands: "",
      SessionKey: canonicalKey,
      Provider: INTERNAL_MESSAGE_CHANNEL,
      Surface: INTERNAL_MESSAGE_CHANNEL,
      OriginatingChannel: originatingChannel,
      OriginatingTo: originatingTo,
      AccountId: delivery?.accountId,
      MessageThreadId: delivery?.threadId,
      MessageSid: `${source}:${randomUUID()}`,
      CommandAuthorized: true,
    },
    dispatcherOptions: {
      ...prefixOptions,
      deliver: async () => {},
      onError: (err, info) => {
        logWarn(`session event dispatch ${info.kind} failed: ${String(err)}`);
      },
    },
    replyOptions: {
      suppressTyping: true,
      allowEmptyBodyForSystemEvent: true,
      onModelSelected,
    },
  });

  return true;
}

export function requestSessionEventRun(params: {
  sessionKey: string;
  source: string;
  agentId?: string;
}) {
  void triggerSessionEventRun(params).catch((err) => {
    logWarn(
      `session event run failed: source=${params.source} session=${params.sessionKey} error=${String(err)}`,
    );
  });
}
