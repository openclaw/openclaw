import { convertMarkdownTables } from "../../../packages/markdown-core/src/tables.js";
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
import {
  settleReplyDispatcher,
  withReplyDispatcher,
} from "../../auto-reply/dispatch-dispatcher.js";
import { formatAgentEnvelope, resolveEnvelopeFormatOptions } from "../../auto-reply/envelope.js";
import {
  createInboundDebouncer,
  resolveInboundDebounceMs,
} from "../../auto-reply/inbound-debounce.js";
import { finalizeInboundContext } from "../../auto-reply/reply/inbound-context.js";
import {
  buildMentionRegexes,
  matchesMentionPatterns,
  matchesMentionWithExplicit,
} from "../../auto-reply/reply/mentions.js";
import { createReplyDispatcherWithTyping } from "../../auto-reply/reply/reply-dispatcher.js";
import {
  createAckReactionHandle,
  removeAckReactionAfterReply,
  removeAckReactionHandleAfterReply,
  shouldAckReaction,
} from "../../channels/ack-reactions.js";
import { resolveCommandAuthorizedFromAuthorizers } from "../../channels/command-gating.js";
import { buildChannelInboundEventContext } from "../../channels/inbound-event/context.js";
import {
  implicitMentionKindWhen,
  resolveInboundMentionDecision,
} from "../../channels/mention-gating.js";
import {
  createChannelIngressPolicyResolver,
  resolveChannelIngressPolicy,
  resolveStableChannelIngressPolicy,
} from "../../channels/message-access/runtime.js";
import {
  setChannelConversationBindingIdleTimeoutBySessionKey,
  setChannelConversationBindingIdleTimeoutBySessionKeyAsync,
  setChannelConversationBindingMaxAgeBySessionKey,
  setChannelConversationBindingMaxAgeBySessionKeyAsync,
} from "../../channels/plugins/conversation-bindings.js";
import { loadChannelOutboundAdapter } from "../../channels/plugins/outbound/load.js";
import { recordInboundSession } from "../../channels/session.js";
import {
  resolveChannelGroupPolicy,
  resolveChannelGroupRequireMention,
} from "../../config/group-policy.js";
import { resolveMarkdownTableMode } from "../../config/markdown-tables.js";
import { resolveSessionStorePathCore } from "../../config/sessions.js";
import { resolveSessionEntryResetFreshness } from "../../config/sessions/entry-freshness.js";
import {
  readSessionUpdatedAtCore,
  recordInboundSessionMeta,
  updateSessionLastRoute,
} from "../../config/sessions/session-accessor.js";
import { getChannelActivity, recordChannelActivity } from "../../infra/channel-activity.js";
import { readRemoteMediaBuffer, saveRemoteMedia, saveResponseMedia } from "../../media/fetch.js";
import { deleteMediaBuffer, saveMediaBuffer } from "../../media/store.js";
import { buildPairingReply } from "../../pairing/pairing-messages.js";
import {
  readChannelAllowFromStore,
  removeChannelAllowFromStoreEntry,
  upsertChannelPairingRequest,
} from "../../pairing/pairing-store.js";
import { buildAgentSessionKey, resolveAgentRoute } from "../../routing/resolve-route.js";
import { createLazyRuntimeMethod, createLazyRuntimeModule } from "../../shared/lazy-runtime.js";
import { createChannelRuntimeContextRegistry } from "./channel-runtime-contexts.js";
import type { PluginRuntime } from "./types.js";

// Text and registration helpers must not initialize the agent dispatch graph.
const dispatchLowLevelChannelReplyFromConfig = createLazyRuntimeMethod(
  createLazyRuntimeModule(() => import("../../auto-reply/reply/dispatch-from-config.js")),
  (runtime) => runtime.dispatchLowLevelChannelReplyFromConfig,
);
const dispatchReplyWithBufferedBlockDispatcherCore = createLazyRuntimeMethod(
  createLazyRuntimeModule(() => import("../../auto-reply/reply/provider-dispatcher.js")),
  (runtime) => runtime.dispatchReplyWithBufferedBlockDispatcherCore,
);
const loadChannelTurnLifecycle = createLazyRuntimeModule(
  () => import("../../channels/turn/lifecycle.js"),
);
const dispatchAssembledChannelTurn = createLazyRuntimeMethod(
  loadChannelTurnLifecycle,
  (runtime) => runtime.dispatchAssembledChannelTurn,
);
const loadPreparedChannelTurn = createLazyRuntimeModule(
  () => import("../../channels/turn/execution.js"),
);
const runPreparedChannelTurn: PluginRuntime["channel"]["inbound"]["runPreparedReply"] = async (
  params,
) => (await loadPreparedChannelTurn()).runPreparedChannelTurn(params);
const runChannelTurn = createLazyRuntimeMethod(
  createLazyRuntimeModule(() => import("../../channels/turn/run-channel-turn.js")),
  (runtime) => runtime.runChannelTurn,
  // SAFETY: Forwarding async overloads unchanged preserves the raw-event and dispatch-result generics.
) as PluginRuntime["channel"]["inbound"]["run"];

export function createRuntimeChannel(options?: {
  dispatchReplyFromConfig?: PluginRuntime["channel"]["reply"]["dispatchReplyFromConfig"];
}): PluginRuntime["channel"] {
  const dispatchInbound: PluginRuntime["channel"]["inbound"]["dispatch"] = async (params) =>
    (await loadChannelTurnLifecycle()).dispatchRoutedChannelTurn({
      ...params,
      ...(options?.dispatchReplyFromConfig
        ? { dispatchReplyFromConfig: options.dispatchReplyFromConfig }
        : {}),
    });
  const inboundRuntime = {
    ingress: {
      createResolver: createChannelIngressPolicyResolver,
      resolve: resolveChannelIngressPolicy,
      resolveStable: resolveStableChannelIngressPolicy,
    },
    buildContext: buildChannelInboundEventContext,
    run: runChannelTurn,
    runPreparedReply: runPreparedChannelTurn,
    dispatch: dispatchInbound,
    dispatchReply: dispatchAssembledChannelTurn,
  } satisfies PluginRuntime["channel"]["inbound"];
  const sessionRuntime = {
    resolveStorePath: resolveSessionStorePathCore,
    readSessionUpdatedAt: readSessionUpdatedAtCore,
    // Plugin runtime property names are a shipped contract; the implementations
    // route through the session accessor boundary.
    recordSessionMetaFromInbound: recordInboundSessionMeta,
    recordInboundSession,
    updateLastRoute: updateSessionLastRoute,
    resolveEntryResetFreshness: resolveSessionEntryResetFreshness,
  };
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
      dispatchReplyWithBufferedBlockDispatcher: dispatchReplyWithBufferedBlockDispatcherCore,
      createReplyDispatcherWithTyping,
      resolveEffectiveMessagesConfig,
      resolveHumanDelayConfig,
      dispatchReplyFromConfig:
        options?.dispatchReplyFromConfig ?? dispatchLowLevelChannelReplyFromConfig,
      withReplyDispatcher,
      settleReplyDispatcher,
      finalizeInboundContext,
      formatAgentEnvelope,
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
      removeAllowFromStoreEntry: ({ channel, entry, accountId, env, pairingAdapter }) =>
        removeChannelAllowFromStoreEntry({
          channel,
          entry,
          accountId,
          env,
          pairingAdapter,
        }),
      upsertPairingRequest: upsertChannelPairingRequest,
    },
    media: {
      readRemoteMediaBuffer,
      fetchRemoteMedia: readRemoteMediaBuffer,
      saveRemoteMedia,
      saveResponseMedia,
      saveMediaBuffer,
      deleteMediaBuffer,
    },
    activity: {
      record: recordChannelActivity,
      get: getChannelActivity,
    },
    session: sessionRuntime,
    mentions: {
      buildMentionRegexes,
      matchesMentionPatterns,
      matchesMentionWithExplicit,
      implicitMentionKindWhen,
      resolveInboundMentionDecision,
    },
    reactions: {
      createAckReactionHandle,
      shouldAckReaction,
      removeAckReactionAfterReply,
      removeAckReactionHandleAfterReply,
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
    outbound: {
      loadAdapter: loadChannelOutboundAdapter,
    },
    inbound: inboundRuntime,
    turn: inboundRuntime,
    threadBindings: {
      setIdleTimeoutBySessionKeyAsync: setChannelConversationBindingIdleTimeoutBySessionKeyAsync,
      setMaxAgeBySessionKeyAsync: setChannelConversationBindingMaxAgeBySessionKeyAsync,
      setIdleTimeoutBySessionKey: setChannelConversationBindingIdleTimeoutBySessionKey,
      setMaxAgeBySessionKey: setChannelConversationBindingMaxAgeBySessionKey,
    },
    runtimeContexts: createChannelRuntimeContextRegistry(),
  } satisfies PluginRuntime["channel"];

  return channelRuntime as PluginRuntime["channel"];
}
