import { auditDiscordChannelPermissions } from "../../../extensions/discord/src/audit.js";
import {
  listDiscordDirectoryGroupsLive,
  listDiscordDirectoryPeersLive,
} from "../../../extensions/discord/src/directory-live.js";
import { monitorDiscordProvider } from "../../../extensions/discord/src/monitor.js";
import { probeDiscord } from "../../../extensions/discord/src/probe.js";
import { resolveDiscordChannelAllowlist } from "../../../extensions/discord/src/resolve-channels.js";
import { resolveDiscordUserAllowlist } from "../../../extensions/discord/src/resolve-users.js";
import {
  createThreadDiscord,
  deleteMessageDiscord,
  editChannelDiscord,
  editMessageDiscord,
  pinMessageDiscord,
  sendDiscordComponentMessage,
  sendMessageDiscord,
  sendPollDiscord,
  sendTypingDiscord,
  unpinMessageDiscord,
} from "../../../extensions/discord/src/send.js";
import { monitorIMessageProvider } from "../../../extensions/imessage/src/monitor.js";
import { probeIMessage } from "../../../extensions/imessage/src/probe.js";
import { sendMessageIMessage } from "../../../extensions/imessage/src/send.js";
import { monitorSignalProvider } from "../../../extensions/signal/src/index.js";
import { probeSignal } from "../../../extensions/signal/src/probe.js";
import { sendMessageSignal } from "../../../extensions/signal/src/send.js";
import {
  listSlackDirectoryGroupsLive,
  listSlackDirectoryPeersLive,
} from "../../../extensions/slack/src/directory-live.js";
import { monitorSlackProvider } from "../../../extensions/slack/src/index.js";
import { probeSlack } from "../../../extensions/slack/src/probe.js";
import { resolveSlackChannelAllowlist } from "../../../extensions/slack/src/resolve-channels.js";
import { resolveSlackUserAllowlist } from "../../../extensions/slack/src/resolve-users.js";
import { sendMessageSlack } from "../../../extensions/slack/src/send.js";
import {
  auditTelegramGroupMembership,
  collectTelegramUnmentionedGroupIds,
} from "../../../extensions/telegram/src/audit.js";
import { monitorTelegramProvider } from "../../../extensions/telegram/src/monitor.js";
import { probeTelegram } from "../../../extensions/telegram/src/probe.js";
import { sendMessageTelegram, sendPollTelegram } from "../../../extensions/telegram/src/send.js";
import { resolveTelegramToken } from "../../../extensions/telegram/src/token.js";
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
import { createReplyDispatcherWithTyping } from "../../auto-reply/reply/reply-dispatcher.js";
import { removeAckReactionAfterReply, shouldAckReaction } from "../../channels/ack-reactions.js";
import { resolveCommandAuthorizedFromAuthorizers } from "../../channels/command-gating.js";
import { discordMessageActions } from "../../channels/plugins/actions/discord.js";
import { signalMessageActions } from "../../channels/plugins/actions/signal.js";
import { telegramMessageActions } from "../../channels/plugins/actions/telegram.js";
import { recordInboundSession } from "../../channels/session.js";
import {
  resolveChannelGroupPolicy,
  resolveChannelGroupRequireMention,
} from "../../config/group-policy.js";
import { resolveMarkdownTableMode } from "../../config/markdown-tables.js";
import {
  readSessionUpdatedAt,
  recordSessionMetaFromInbound,
  resolveStorePath,
  updateLastRoute,
} from "../../config/sessions.js";
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
import { createDiscordTypingLease } from "./runtime-discord-typing.js";
import { createTelegramTypingLease } from "./runtime-telegram-typing.js";
import { createRuntimeWhatsApp } from "./runtime-whatsapp.js";
import type { PluginRuntime } from "./types.js";

export function createRuntimeChannel(): PluginRuntime["channel"] {
  return {
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
      sendComponentMessage: sendDiscordComponentMessage,
      sendMessageDiscord,
      sendPollDiscord,
      monitorDiscordProvider,
      typing: {
        pulse: sendTypingDiscord,
        start: async ({ channelId, accountId, cfg, intervalMs }) =>
          await createDiscordTypingLease({
            channelId,
            accountId,
            cfg,
            intervalMs,
            pulse: async ({ channelId, accountId, cfg }) =>
              void (await sendTypingDiscord(channelId, {
                accountId,
                cfg,
              })),
          }),
      },
      conversationActions: {
        editMessage: editMessageDiscord,
        deleteMessage: deleteMessageDiscord,
        pinMessage: pinMessageDiscord,
        unpinMessage: unpinMessageDiscord,
        createThread: createThreadDiscord,
        editChannel: editChannelDiscord,
      },
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
      typing: {
        pulse: sendTypingTelegram,
        start: async ({ to, accountId, cfg, intervalMs, messageThreadId }) =>
          await createTelegramTypingLease({
            to,
            accountId,
            cfg,
            intervalMs,
            messageThreadId,
            pulse: async ({ to, accountId, cfg, messageThreadId }) =>
              await sendTypingTelegram(to, {
                accountId,
                cfg,
                messageThreadId,
              }),
          }),
      },
      conversationActions: {
        editMessage: editMessageTelegram,
        editReplyMarkup: editMessageReplyMarkupTelegram,
        clearReplyMarkup: async (chatIdInput, messageIdInput, opts = {}) =>
          await editMessageReplyMarkupTelegram(chatIdInput, messageIdInput, [], opts),
        deleteMessage: deleteMessageTelegram,
        renameTopic: renameForumTopicTelegram,
        pinMessage: pinMessageTelegram,
        unpinMessage: unpinMessageTelegram,
      },
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
