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
import { pluginInstanceInvocation } from "../plugin-instance-invocation.js";
import {
  getPluginInstanceOwner,
  getPluginOriginalValue,
  getPluginValueInstance,
} from "../plugin-instance-scope.js";
import type { PluginInstanceConsumer } from "../plugin-instance.types.js";
import { createChannelRuntimeContextRegistry } from "./channel-runtime-contexts.js";
import { getPluginRuntimeGenerationRegistry } from "./generation-state.js";
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
const dispatchAssembledChannelTurnCore = createLazyRuntimeMethod(
  loadChannelTurnLifecycle,
  (runtime) => runtime.dispatchAssembledChannelTurn,
);
function bindChannelCallbacks<T extends object>(callbacks: T, consumer: PluginInstanceConsumer): T {
  const instance = getPluginValueInstance(consumer.wrap(() => undefined))!;
  const original = getPluginOriginalValue(callbacks, instance);
  // SAFETY: Only the creating instance can restore this callback object's original shape.
  const owned = consumer.wrap((original ?? callbacks) as T);
  return new Proxy(owned, {
    get: (target, key) =>
      consumer.run(() => {
        const value: unknown = Reflect.get(target, key, target);
        return value && typeof value === "object"
          ? (getPluginOriginalValue(value, instance) ?? value)
          : value;
      }),
  });
}
function bindChannelDelivery<T extends { delivery: object; replyOptions?: object }>(
  params: T,
  consumer?: PluginInstanceConsumer,
): T {
  return consumer
    ? {
        ...params,
        delivery: consumer.wrap(params.delivery),
        ...(params.replyOptions
          ? { replyOptions: bindChannelCallbacks(params.replyOptions, consumer) }
          : {}),
      }
    : params;
}
async function withChannelDeliveryCustody<T, R>(
  params: T,
  dispatch: (params: T, consumer?: PluginInstanceConsumer) => Promise<R>,
): Promise<R> {
  const invocation = pluginInstanceInvocation.getStore();
  const owner = invocation && getPluginInstanceOwner(invocation.instance);
  const generation = getPluginRuntimeGenerationRegistry();
  const consumer = owner?.instance?.retainConsumer(
    undefined,
    generation?.plugins.includes(owner.record) ? generation : owner.registry,
  );
  try {
    return await dispatch(params, consumer);
  } finally {
    consumer?.release();
  }
}
const dispatchAssembledChannelTurn: PluginRuntime["channel"]["inbound"]["dispatchReply"] = (
  params,
) =>
  withChannelDeliveryCustody(params, (turn, consumer) =>
    dispatchAssembledChannelTurnCore(publicChannelTurn(bindChannelDelivery(turn, consumer))),
  );
const loadPreparedChannelTurn = createLazyRuntimeModule(
  () => import("../../channels/turn/execution.js"),
);
const runPreparedChannelTurn: PluginRuntime["channel"]["inbound"]["runPreparedReply"] = async (
  params,
) => (await loadPreparedChannelTurn()).runPreparedChannelTurn(params);
const runChannelTurnCore = createLazyRuntimeMethod(
  createLazyRuntimeModule(() => import("../../channels/turn/run-channel-turn.js")),
  (runtime) => runtime.runChannelTurn,
  // SAFETY: Forwarding async overloads unchanged preserves the raw-event and dispatch-result generics.
) as typeof import("../../channels/turn/run-channel-turn.js").runChannelTurn;
const runChannelTurn = ((params: Parameters<typeof runChannelTurnCore>[0]) =>
  withChannelDeliveryCustody(params, (turn, consumer) => {
    if (!consumer) {
      return runChannelTurnCore(publicChannelTurnParams(turn));
    }
    const adapter = bindChannelCallbacks(turn.adapter, consumer);
    const resolveTurn: typeof adapter.resolveTurn = async (...args) => {
      const resolved = await adapter.resolveTurn(...args);
      const instance = getPluginValueInstance(consumer.wrap(() => undefined))!;
      // SAFETY: Exact-owner restoration preserves the adapter's resolved turn contract.
      const original = (getPluginOriginalValue(resolved, instance) ?? resolved) as typeof resolved;
      return "delivery" in original ? bindChannelDelivery(original, consumer) : original;
    };
    return runChannelTurnCore(
      publicChannelTurnParams({
        ...turn,
        adapter: new Proxy(adapter, {
          get: (target, key) =>
            key === "resolveTurn" ? resolveTurn : Reflect.get(target, key, target),
        }),
      }),
    );
    // SAFETY: Forwarding async overloads unchanged preserves raw-event and dispatch-result generics.
  })) as typeof import("../../channels/turn/run-channel-turn.js").runChannelTurn;

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
    return run(params);
  };
  const dispatchInbound: PluginRuntime["channel"]["inbound"]["dispatch"] = (params) =>
    withChannelDeliveryCustody(params, async (turn, consumer) =>
      (await loadChannelTurnLifecycle()).dispatchRoutedChannelTurn({
        ...publicChannelTurn(bindChannelDelivery(turn, consumer)),
        ...(options?.dispatchReplyFromConfig
          ? { dispatchReplyFromConfig: options.dispatchReplyFromConfig }
          : {}),
      }),
    );
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
    dispatchReply: dispatchAssembledChannelTurn,
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
