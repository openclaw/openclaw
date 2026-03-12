import { resolveSessionAgentIds } from "../../agents/agent-scope.js";
import { resolveEffectiveMessagesConfig, resolveHumanDelayConfig } from "../../agents/identity.js";
import { handleSlackAction } from "../../agents/tools/slack-actions.js";
import {
  chunkByNewline,
  chunkMarkdownText,
  chunkMarkdownTextWithMode,
  chunkText,
  chunkTextWithMode,
  resolveChunkMode,
  resolveTextChunkLimit,
} from "../../auto-reply/chunk.js";
import {
  hasControlCommand,
  isControlCommandMessage,
  shouldComputeCommandAuthorized,
} from "../../auto-reply/command-detection.js";
import { shouldHandleTextCommands } from "../../auto-reply/commands-registry.js";
import { withReplyDispatcher } from "../../auto-reply/dispatch.js";
import {
  formatAgentEnvelope,
  formatInboundEnvelope,
  resolveEnvelopeFormatOptions,
} from "../../auto-reply/envelope.js";
import {
  createInboundDebouncer,
  resolveInboundDebounceMs,
} from "../../auto-reply/inbound-debounce.js";
import { dispatchReplyFromConfig } from "../../auto-reply/reply/dispatch-from-config.js";
import { finalizeInboundContext } from "../../auto-reply/reply/inbound-context.js";
import {
  buildMentionRegexes,
  matchesMentionPatterns,
  matchesMentionWithExplicit,
} from "../../auto-reply/reply/mentions.js";
import { dispatchReplyWithBufferedBlockDispatcher } from "../../auto-reply/reply/provider-dispatcher.js";
import { routeReply } from "../../auto-reply/reply/route-reply.js";
import { createReplyDispatcherWithTyping } from "../../auto-reply/reply/reply-dispatcher.js";
import { removeAckReactionAfterReply, shouldAckReaction } from "../../channels/ack-reactions.js";
import { resolveCommandAuthorizedFromAuthorizers } from "../../channels/command-gating.js";
import { discordMessageActions } from "../../channels/plugins/actions/discord.js";
import { signalMessageActions } from "../../channels/plugins/actions/signal.js";
import { telegramMessageActions } from "../../channels/plugins/actions/telegram.js";
import { recordInboundSession } from "../../channels/session.js";
import { normalizeChatType } from "../../channels/chat-type.js";
import {
  resolveChannelGroupPolicy,
  resolveChannelGroupRequireMention,
} from "../../config/group-policy.js";
import { resolveMarkdownTableMode } from "../../config/markdown-tables.js";
import { loadConfig } from "../../config/config.js";
import {
  readSessionUpdatedAt,
  recordSessionMetaFromInbound,
  resolveStorePath,
  updateLastRoute,
} from "../../config/sessions.js";
import { auditDiscordChannelPermissions } from "../../discord/audit.js";
import {
  listDiscordDirectoryGroupsLive,
  listDiscordDirectoryPeersLive,
} from "../../discord/directory-live.js";
import { monitorDiscordProvider } from "../../discord/monitor.js";
import { probeDiscord } from "../../discord/probe.js";
import { resolveDiscordChannelAllowlist } from "../../discord/resolve-channels.js";
import { resolveDiscordUserAllowlist } from "../../discord/resolve-users.js";
import { sendMessageDiscord, sendPollDiscord } from "../../discord/send.js";
import { monitorIMessageProvider } from "../../imessage/monitor.js";
import { probeIMessage } from "../../imessage/probe.js";
import { sendMessageIMessage } from "../../imessage/send.js";
import { getChannelActivity, recordChannelActivity } from "../../infra/channel-activity.js";
import {
  listLineAccountIds,
  normalizeAccountId as normalizeLineAccountId,
  resolveDefaultLineAccountId,
  resolveLineAccount,
} from "../../line/accounts.js";
import { monitorLineProvider } from "../../line/monitor.js";
import { probeLineBot } from "../../line/probe.js";
import {
  createQuickReplyItems,
  pushFlexMessage,
  pushLocationMessage,
  pushMessageLine,
  pushMessagesLine,
  pushTemplateMessage,
  pushTextMessageWithQuickReplies,
  sendMessageLine,
} from "../../line/send.js";
import { buildTemplateMessageFromPayload } from "../../line/template-messages.js";
import { convertMarkdownTables } from "../../markdown/tables.js";
import { fetchRemoteMedia } from "../../media/fetch.js";
import { saveMediaBuffer } from "../../media/store.js";
import { buildPairingReply } from "../../pairing/pairing-messages.js";
import {
  readChannelAllowFromStore,
  upsertChannelPairingRequest,
} from "../../pairing/pairing-store.js";
import { buildAgentSessionKey, resolveAgentRoute } from "../../routing/resolve-route.js";
import { monitorSignalProvider } from "../../signal/index.js";
import { probeSignal } from "../../signal/probe.js";
import { sendMessageSignal } from "../../signal/send.js";
import {
  listSlackDirectoryGroupsLive,
  listSlackDirectoryPeersLive,
} from "../../slack/directory-live.js";
import { monitorSlackProvider } from "../../slack/index.js";
import { probeSlack } from "../../slack/probe.js";
import { resolveSlackChannelAllowlist } from "../../slack/resolve-channels.js";
import { resolveSlackUserAllowlist } from "../../slack/resolve-users.js";
import { sendMessageSlack } from "../../slack/send.js";
import {
  auditTelegramGroupMembership,
  collectTelegramUnmentionedGroupIds,
} from "../../telegram/audit.js";
import { monitorTelegramProvider } from "../../telegram/monitor.js";
import { probeTelegram } from "../../telegram/probe.js";
import { sendMessageTelegram, sendPollTelegram } from "../../telegram/send.js";
import { resolveTelegramToken } from "../../telegram/token.js";
import { createRuntimeWhatsApp } from "./runtime-whatsapp.js";
import type { PluginChannelDispatchInboundParams, PluginRuntime } from "./types.js";

function resolveDispatchChatType(raw: string | undefined): "direct" | "group" | "channel" {
  return normalizeChatType(raw) ?? "direct";
}

function resolveDispatchTarget(
  params: PluginChannelDispatchInboundParams,
  chatType: "direct" | "group" | "channel",
): string {
  const explicit = String(params.originatingTo ?? "").trim();
  if (explicit) {
    return explicit;
  }
  const userId = String(params.userId ?? "").trim();
  const chatId = String(params.chatId ?? "").trim();
  if (chatType === "direct") {
    return userId || chatId;
  }
  return chatId || userId;
}

export function createRuntimeChannel(): PluginRuntime["channel"] {
  return {
    dispatchInbound: async (params) => {
      const channel = String(params.channel || "").trim().toLowerCase();
      if (!channel) {
        throw new Error("runtime.channel.dispatchInbound requires channel");
      }
      const sessionKey = String(params.sessionKey || "").trim();
      if (!sessionKey) {
        throw new Error("runtime.channel.dispatchInbound requires sessionKey");
      }
      const chatType = resolveDispatchChatType(params.chatType);
      const originatingTo = resolveDispatchTarget(params, chatType);
      if (!originatingTo) {
        throw new Error("runtime.channel.dispatchInbound requires userId/chatId");
      }
      const senderId = String(params.senderId ?? params.userId ?? "").trim() || undefined;
      const fromBase =
        senderId ??
        String(params.chatId ?? params.userId ?? originatingTo)
          .trim();
      const toBase = String(params.chatId ?? params.userId ?? originatingTo).trim();
      const messageId = String(params.messageId ?? "").trim() || undefined;
      const timestamp =
        typeof params.timestamp === "number" && Number.isFinite(params.timestamp)
          ? params.timestamp
          : undefined;
      const text = String(params.text ?? "");
      const cfg = await loadConfig();
      const ctx = finalizeInboundContext({
        Body: text,
        RawBody: text,
        CommandBody: text,
        BodyForCommands: text,
        From: `${channel}:${fromBase || originatingTo}`,
        To: `${channel}:${toBase || originatingTo}`,
        SessionKey: sessionKey,
        AccountId: params.accountId,
        ChatType: chatType,
        ConversationLabel: String(params.chatId ?? params.userId ?? originatingTo).trim() || undefined,
        SenderId: senderId,
        SenderName: params.senderName,
        SenderUsername: params.senderUsername,
        SenderTag: params.senderTag,
        Provider: channel,
        Surface: channel,
        MessageSid: messageId,
        Timestamp: timestamp,
        CommandAuthorized: false,
        MessageThreadId: params.threadId,
        OriginatingChannel: channel,
        OriginatingTo: originatingTo,
      });

      const { sessionAgentId: agentId } = resolveSessionAgentIds({
        sessionKey,
        config: cfg,
        agentId: params.targetAgentId,
      });
      const storePath = resolveStorePath(cfg.session?.store, { agentId });
      await recordInboundSession({
        storePath,
        sessionKey,
        ctx,
        updateLastRoute:
          chatType === "direct"
            ? {
                sessionKey,
                channel,
                to: originatingTo,
                accountId: params.accountId,
                threadId: params.threadId != null ? String(params.threadId) : undefined,
              }
            : undefined,
        onRecordError: () => undefined,
      });

      return await dispatchReplyWithBufferedBlockDispatcher({
        ctx,
        cfg,
        dispatcherOptions: {
          deliver: async (payload) => {
            const routed = await routeReply({
              payload,
              channel,
              to: originatingTo,
              sessionKey,
              accountId: params.accountId,
              threadId: params.threadId,
              cfg,
            });
            if (!routed.ok) {
              throw new Error(
                routed.error ?? `runtime.channel.dispatchInbound failed to route reply for ${channel}`,
              );
            }
          },
        },
      });
    },
    text: {
      chunkByNewline,
      chunkMarkdownText,
      chunkMarkdownTextWithMode,
      chunkText,
      chunkTextWithMode,
      resolveChunkMode,
      resolveTextChunkLimit,
      hasControlCommand,
      resolveMarkdownTableMode,
      convertMarkdownTables,
    },
    reply: {
      dispatchReplyWithBufferedBlockDispatcher,
      createReplyDispatcherWithTyping,
      resolveEffectiveMessagesConfig,
      resolveHumanDelayConfig,
      dispatchReplyFromConfig,
      withReplyDispatcher,
      finalizeInboundContext,
      formatAgentEnvelope,
      /** @deprecated Prefer `BodyForAgent` + structured user-context blocks (do not build plaintext envelopes for prompts). */
      formatInboundEnvelope,
      resolveEnvelopeFormatOptions,
    },
    routing: {
      buildAgentSessionKey,
      resolveAgentRoute,
    },
    pairing: {
      buildPairingReply,
      readAllowFromStore: ({ channel, accountId, env }) =>
        readChannelAllowFromStore(channel, env, accountId),
      upsertPairingRequest: ({ channel, id, accountId, meta, env, pairingAdapter }) =>
        upsertChannelPairingRequest({
          channel,
          id,
          accountId,
          meta,
          env,
          pairingAdapter,
        }),
    },
    media: {
      fetchRemoteMedia,
      saveMediaBuffer,
    },
    activity: {
      record: recordChannelActivity,
      get: getChannelActivity,
    },
    session: {
      resolveStorePath,
      readSessionUpdatedAt,
      recordSessionMetaFromInbound,
      recordInboundSession,
      updateLastRoute,
    },
    mentions: {
      buildMentionRegexes,
      matchesMentionPatterns,
      matchesMentionWithExplicit,
    },
    reactions: {
      shouldAckReaction,
      removeAckReactionAfterReply,
    },
    groups: {
      resolveGroupPolicy: resolveChannelGroupPolicy,
      resolveRequireMention: resolveChannelGroupRequireMention,
    },
    debounce: {
      createInboundDebouncer,
      resolveInboundDebounceMs,
    },
    commands: {
      resolveCommandAuthorizedFromAuthorizers,
      isControlCommandMessage,
      shouldComputeCommandAuthorized,
      shouldHandleTextCommands,
    },
    discord: {
      messageActions: discordMessageActions,
      auditChannelPermissions: auditDiscordChannelPermissions,
      listDirectoryGroupsLive: listDiscordDirectoryGroupsLive,
      listDirectoryPeersLive: listDiscordDirectoryPeersLive,
      probeDiscord,
      resolveChannelAllowlist: resolveDiscordChannelAllowlist,
      resolveUserAllowlist: resolveDiscordUserAllowlist,
      sendMessageDiscord,
      sendPollDiscord,
      monitorDiscordProvider,
    },
    slack: {
      listDirectoryGroupsLive: listSlackDirectoryGroupsLive,
      listDirectoryPeersLive: listSlackDirectoryPeersLive,
      probeSlack,
      resolveChannelAllowlist: resolveSlackChannelAllowlist,
      resolveUserAllowlist: resolveSlackUserAllowlist,
      sendMessageSlack,
      monitorSlackProvider,
      handleSlackAction,
    },
    telegram: {
      auditGroupMembership: auditTelegramGroupMembership,
      collectUnmentionedGroupIds: collectTelegramUnmentionedGroupIds,
      probeTelegram,
      resolveTelegramToken,
      sendMessageTelegram,
      sendPollTelegram,
      monitorTelegramProvider,
      messageActions: telegramMessageActions,
    },
    signal: {
      probeSignal,
      sendMessageSignal,
      monitorSignalProvider,
      messageActions: signalMessageActions,
    },
    imessage: {
      monitorIMessageProvider,
      probeIMessage,
      sendMessageIMessage,
    },
    whatsapp: createRuntimeWhatsApp(),
    line: {
      listLineAccountIds,
      resolveDefaultLineAccountId,
      resolveLineAccount,
      normalizeAccountId: normalizeLineAccountId,
      probeLineBot,
      sendMessageLine,
      pushMessageLine,
      pushMessagesLine,
      pushFlexMessage,
      pushTemplateMessage,
      pushLocationMessage,
      pushTextMessageWithQuickReplies,
      createQuickReplyItems,
      buildTemplateMessageFromPayload,
      monitorLineProvider,
    },
  };
}
