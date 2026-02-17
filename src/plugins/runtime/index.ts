import { createRequire } from "node:module";
import type { PluginRuntime } from "./types.js";
import { resolveEffectiveMessagesConfig, resolveHumanDelayConfig } from "../../agents/identity.js";
import { createMemoryGetTool, createMemorySearchTool } from "../../agents/tools/memory-tool.js";
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
import { telegramMessageActions } from "../../channels/plugins/actions/telegram.js";
import { recordInboundSession } from "../../channels/session.js";
import { registerMemoryCli } from "../../cli/memory-cli.js";
import { loadConfig, writeConfigFile } from "../../config/config.js";
import {
  resolveChannelGroupPolicy,
  resolveChannelGroupRequireMention,
} from "../../config/group-policy.js";
import { resolveMarkdownTableMode } from "../../config/markdown-tables.js";
import { resolveStateDir } from "../../config/paths.js";
import {
  readSessionUpdatedAt,
  recordSessionMetaFromInbound,
  resolveStorePath,
  updateLastRoute,
} from "../../config/sessions.js";
import { shouldLogVerbose } from "../../globals.js";
import { getChannelActivity, recordChannelActivity } from "../../infra/channel-activity.js";
import { requestHeartbeatNow } from "../../infra/heartbeat-wake.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import { getChildLogger } from "../../logging.js";
import { normalizeLogLevel } from "../../logging/levels.js";
import { convertMarkdownTables } from "../../markdown/tables.js";
import { isVoiceCompatibleAudio } from "../../media/audio.js";
import { mediaKindFromMime } from "../../media/constants.js";
import { fetchRemoteMedia } from "../../media/fetch.js";
import { getImageMetadata, resizeToJpeg } from "../../media/image-ops.js";
import { loadWebMedia } from "../../media/load-web-media.js";
import { detectMime } from "../../media/mime.js";
import { saveMediaBuffer } from "../../media/store.js";
import { buildPairingReply } from "../../pairing/pairing-messages.js";
import {
  readChannelAllowFromStore,
  upsertChannelPairingRequest,
} from "../../pairing/pairing-store.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { resolveAgentRoute } from "../../routing/resolve-route.js";
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
import { sendMessageTelegram } from "../../telegram/send.js";
import { resolveTelegramToken } from "../../telegram/token.js";
import { textToSpeechTelephony } from "../../tts/tts.js";
import { formatNativeDependencyHint } from "./native-deps.js";

let cachedVersion: string | null = null;

function resolveVersion(): string {
  if (cachedVersion) {
    return cachedVersion;
  }
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("../../../package.json") as { version?: string };
    cachedVersion = pkg.version ?? "unknown";
    return cachedVersion;
  } catch {
    cachedVersion = "unknown";
    return cachedVersion;
  }
}

export function createPluginRuntime(): PluginRuntime {
  return {
    version: resolveVersion(),
    config: {
      loadConfig,
      writeConfigFile,
    },
    system: {
      enqueueSystemEvent,
      requestHeartbeatNow,
      runCommandWithTimeout,
      formatNativeDependencyHint,
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
      loadWebMedia,
      detectMime,
      mediaKindFromMime,
      isVoiceCompatibleAudio,
      getImageMetadata,
      resizeToJpeg,
    },
    tts: {
      textToSpeechTelephony,
    },
    tools: {
      createMemoryGetTool,
      createMemorySearchTool,
      registerMemoryCli,
    },
    channel: {
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
        finalizeInboundContext,
        formatAgentEnvelope,
        /** @deprecated Prefer `BodyForAgent` + structured user-context blocks (do not build plaintext envelopes for prompts). */
        formatInboundEnvelope,
        resolveEnvelopeFormatOptions,
      },
      routing: {
        resolveAgentRoute,
      },
      pairing: {
        buildPairingReply,
        readAllowFromStore: readChannelAllowFromStore,
        upsertPairingRequest: upsertChannelPairingRequest,
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
        monitorTelegramProvider,
        messageActions: telegramMessageActions,
      },
    },
    logging: {
      shouldLogVerbose,
      getChildLogger: (bindings, opts) => {
        const logger = getChildLogger(bindings, {
          level: opts?.level ? normalizeLogLevel(opts.level) : undefined,
        });
        return {
          debug: (message) => logger.debug?.(message),
          info: (message) => logger.info(message),
          warn: (message) => logger.warn(message),
          error: (message) => logger.error(message),
        };
      },
    },
    state: {
      resolveStateDir,
    },
  };
}

export type { PluginRuntime } from "./types.js";
