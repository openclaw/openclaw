import { resolveEffectiveMessagesConfig, resolveHumanDelayConfig } from "../../agents/identity.js";
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
import { createRuntimeDiscord } from "./runtime-discord.js";
import { createRuntimeIMessage } from "./runtime-imessage.js";
import { createRuntimeMatrix } from "./runtime-matrix.js";
import { createRuntimeSignal } from "./runtime-signal.js";
import { createRuntimeSlack } from "./runtime-slack.js";
import { createRuntimeTelegram } from "./runtime-telegram.js";
import { createRuntimeWhatsApp } from "./runtime-whatsapp.js";
import type { PluginRuntime } from "./types.js";

function defineCachedValue<T extends object, K extends PropertyKey>(
  target: T,
  key: K,
  create: () => unknown,
): void {
  let cached: unknown;
  let ready = false;
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    get() {
      if (!ready) {
        cached = create();
        ready = true;
      }
      return cached;
    },
  });
}

export function createRuntimeChannel(): PluginRuntime["channel"] {
  const channelRuntime = {
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
  } satisfies Omit<
    PluginRuntime["channel"],
    "discord" | "slack" | "telegram" | "matrix" | "signal" | "imessage" | "whatsapp"
  > &
    Partial<
      Pick<
        PluginRuntime["channel"],
        "discord" | "slack" | "telegram" | "matrix" | "signal" | "imessage" | "whatsapp"
      >
    >;

  defineCachedValue(channelRuntime, "discord", createRuntimeDiscord);
  defineCachedValue(channelRuntime, "slack", createRuntimeSlack);
  defineCachedValue(channelRuntime, "telegram", createRuntimeTelegram);
  defineCachedValue(channelRuntime, "matrix", createRuntimeMatrix);
  defineCachedValue(channelRuntime, "signal", createRuntimeSignal);
  defineCachedValue(channelRuntime, "imessage", createRuntimeIMessage);
  defineCachedValue(channelRuntime, "whatsapp", createRuntimeWhatsApp);

  return channelRuntime as PluginRuntime["channel"];
}
