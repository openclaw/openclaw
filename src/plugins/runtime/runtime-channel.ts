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
import type {
  ChannelTurnDeliveryAdapter,
  ChannelTurnResult,
  RunChannelTurnParams,
} from "../../channels/turn/types.js";
import {
  resolveChannelGroupPolicy,
  resolveChannelGroupRequireMention,
} from "../../config/group-policy.js";
import { resolveMarkdownTableMode } from "../../config/markdown-tables.js";
import { resolveSessionStorePathCore } from "../../config/sessions.js";
import {
  resolveSessionEntryResetFreshness,
  resolveSessionEntryResetFreshnessAsync,
} from "../../config/sessions/entry-freshness.js";
import {
  readSessionUpdatedAtCore,
  recordInboundSessionMeta,
} from "../../config/sessions/session-accessor.js";
import { readSessionUpdatedAtInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { getChannelActivity, recordChannelActivity } from "../../infra/channel-activity.js";
import { readRemoteMediaBuffer, saveRemoteMedia, saveResponseMedia } from "../../media/fetch.js";
import { saveMediaBuffer } from "../../media/store.js";
import { buildPairingReply } from "../../pairing/pairing-messages.js";
import {
  readChannelAllowFromStore,
  removeChannelAllowFromStoreEntry,
  upsertChannelPairingRequest,
} from "../../pairing/pairing-store.js";
import {
  publicChannelTurn,
  publicChannelTurnParams,
  type PublicChannelTurnParams,
} from "../../plugin-sdk/reply-options.js";
import {
  updateLastRoute,
  updateLastRouteWithAuthority,
} from "../../plugin-sdk/session-store-runtime.js";
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
) as typeof import("../../channels/turn/run-channel-turn.js").runChannelTurn;

export function createRuntimeChannel(options?: {
  dispatchReplyFromConfig?: typeof dispatchLowLevelChannelReplyFromConfig;
}): PluginRuntime["channel"] {
  const runInbound = <TRaw, TResult>(
    params: PublicChannelTurnParams<TRaw, TResult, ChannelTurnDeliveryAdapter>,
  ): Promise<ChannelTurnResult<TResult>> => {
    // SAFETY: Core's implementation handles both delivery adapters while preserving the result type.
    const run = runChannelTurn as (
      value: RunChannelTurnParams<TRaw, TResult, ChannelTurnDeliveryAdapter>,
    ) => Promise<ChannelTurnResult<TResult>>;
    return run(publicChannelTurnParams(params));
  };
  const dispatchInbound: PluginRuntime["channel"]["inbound"]["dispatch"] = async (params) =>
    (await loadChannelTurnLifecycle()).dispatchRoutedChannelTurn({
      ...publicChannelTurn(params),
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
    run: runInbound,
    runPreparedReply: runPreparedChannelTurn,
    dispatch: dispatchInbound,
    dispatchReply: (params) => dispatchAssembledChannelTurn(publicChannelTurn(params)),
  } satisfies PluginRuntime["channel"]["inbound"];
  const sessionRuntime = {
    resolveStorePath: resolveSessionStorePathCore,
    readSessionUpdatedAt: readSessionUpdatedAtCore,
    readSessionUpdatedAtAsync: readSessionUpdatedAtInWorker,
    // Plugin runtime property names are a shipped contract; the implementations
    // route through the session accessor boundary.
    recordSessionMetaFromInbound: recordInboundSessionMeta,
    recordInboundSession,
    updateLastRoute,
    updateLastRouteWithAuthority,
    resolveEntryResetFreshness: resolveSessionEntryResetFreshness,
    resolveEntryResetFreshnessAsync: resolveSessionEntryResetFreshnessAsync,
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
      dispatchReplyWithBufferedBlockDispatcher: (params) =>
        dispatchReplyWithBufferedBlockDispatcherCore(publicChannelTurn(params)),
      createReplyDispatcherWithTyping,
      resolveEffectiveMessagesConfig,
      resolveHumanDelayConfig,
      dispatchReplyFromConfig: (params) =>
        (options?.dispatchReplyFromConfig ?? dispatchLowLevelChannelReplyFromConfig)(
          publicChannelTurn(params),
        ),
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

  return channelRuntime;
}
