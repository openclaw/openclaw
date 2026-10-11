import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { normalizeOptionalTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import { resolveFastModeState } from "../../agents/fast-mode.js";
import {
  findModelInCatalog,
  prepareModelRunCapabilities,
  type PreparedModelThinkingCapability,
} from "../../agents/model-catalog-lookup.js";
import {
  normalizeThinkingCatalogProviders,
  resolveCandidateThinkingLevel,
} from "../../agents/thinking-runtime.js";
import { normalizeChatType } from "../../channels/chat-type.js";
import { getChannelPlugin } from "../../channels/plugins/index.js";
import type { ChannelId } from "../../channels/plugins/types.public.js";
import { normalizeAnyChannelId, normalizeChatChannelId } from "../../channels/registry.js";
import type { InternalChannelThreadingToolContext } from "../../channels/threading-tool-context-internal.js";
import { resolveCommandSecretRefsViaGateway } from "../../cli/command-secret-gateway.js";
import {
  getAgentRuntimeCommandSecretTargetIds,
  getAgentRuntimeOptionalCommandSecretPaths,
  getScopedChannelsCommandSecretTargets,
} from "../../cli/command-secret-targets.js";
import { resolveMessageSecretScope } from "../../cli/message-secret-scope.js";
import {
  getRuntimeConfigSnapshot,
  getRuntimeConfigSourceSnapshot,
  selectApplicableRuntimeConfig,
  type OpenClawConfig,
} from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import {
  isTrustedMessageActionTurnIngress,
  mintMessageActionTurnCapability,
  resolveMessageActionTurnCapabilityLifetime,
} from "../../gateway/message-action-turn-capability.js";
import { readUserTurnPromptReactionSource } from "../../sessions/user-turn-transcript-admission.js";
import { isInternalMessageChannel } from "../../utils/message-channel.js";
import { isReasoningTagProvider } from "../../utils/provider-utils.js";
import type { TemplateContext } from "../templating.js";
import { resolveRunAuthProfile } from "./agent-runner-auth-profile.js";
import type { AgentTurnParams } from "./agent-runner-execution.types.js";
import {
  buildReplyRunStateParams,
  resolveModelFallbackOptions,
  resolveRunModelHasVision,
} from "./agent-runner-run-params.js";
import { hasInboundAudio } from "./inbound-media.js";
import { resolveOriginMessageProvider } from "./origin-routing.js";
import type { FollowupRun } from "./queue.js";
import { readChannelSourceTurnId } from "./source-turn-id.js";
export { resolveModelFallbackOptions } from "./agent-runner-run-params.js";

type EmbeddedReplyRoute = Pick<
  FollowupRun,
  | "originatingChannel"
  | "originatingTo"
  | "originatingAccountId"
  | "originatingChatType"
  | "originatingThreadId"
  | "originatingReplyToId"
  | "originatingReplyToMode"
>;

export function resolveQueuedReplyRuntimeConfig(config: OpenClawConfig): OpenClawConfig {
  return (
    selectApplicableRuntimeConfig({
      inputConfig: config,
      runtimeConfig: getRuntimeConfigSnapshot(),
      runtimeSourceConfig: getRuntimeConfigSourceSnapshot(),
    }) ?? config
  );
}

export async function resolveQueuedReplyExecutionConfig(
  config: OpenClawConfig,
  params?: {
    originatingChannel?: string;
    messageProvider?: string;
    originatingAccountId?: string;
    agentAccountId?: string;
  },
): Promise<OpenClawConfig> {
  const runtimeConfig = resolveQueuedReplyRuntimeConfig(config);
  const { resolvedConfig } = await resolveCommandSecretRefsViaGateway({
    config: runtimeConfig,
    commandName: "reply",
    targetIds: getAgentRuntimeCommandSecretTargetIds({ config: runtimeConfig }),
    optionalActivePaths: getAgentRuntimeOptionalCommandSecretPaths(runtimeConfig),
  });
  const baseResolvedConfig = resolvedConfig ?? runtimeConfig;

  const scope = resolveMessageSecretScope({
    channel: params?.originatingChannel,
    fallbackChannel: params?.messageProvider,
    accountId: params?.originatingAccountId,
    fallbackAccountId: params?.agentAccountId,
  });
  if (!scope.channel) {
    return baseResolvedConfig;
  }

  const scopedTargets = getScopedChannelsCommandSecretTargets({
    config: baseResolvedConfig,
    channel: scope.channel,
    accountId: scope.accountId,
  });
  if (scopedTargets.targetIds.size === 0) {
    return baseResolvedConfig;
  }

  const scopedResolved = await resolveCommandSecretRefsViaGateway({
    config: baseResolvedConfig,
    commandName: "reply",
    targetIds: scopedTargets.targetIds,
    ...(scopedTargets.allowedPaths ? { allowedPaths: scopedTargets.allowedPaths } : {}),
  });
  return scopedResolved.resolvedConfig ?? baseResolvedConfig;
}

export function buildThreadingToolContext(params: {
  sessionCtx: TemplateContext;
  config: OpenClawConfig | undefined;
  hasRepliedRef: { value: boolean } | undefined;
}): InternalChannelThreadingToolContext {
  const { sessionCtx, config, hasRepliedRef } = params;
  const isRestartSentinelContinuation =
    sessionCtx.InputProvenance?.kind === "internal_system" &&
    sessionCtx.InputProvenance.sourceTool === "restart-sentinel";
  // Gateway chat IDs identify admitted runs, not messages on the inherited channel.
  // Keep that identity in sessionCtx for recovery, but never use it as a reply target.
  const currentMessageId = isRestartSentinelContinuation
    ? sessionCtx.ReplyToId
    : isInternalMessageChannel(sessionCtx.Provider ?? sessionCtx.Surface)
      ? undefined
      : (sessionCtx.MessageSidFull ?? sessionCtx.MessageSid);
  const currentSourceTurnId = readChannelSourceTurnId(sessionCtx);
  const originProvider = resolveOriginMessageProvider({
    originatingChannel: sessionCtx.OriginatingChannel,
    provider: sessionCtx.Provider,
  });
  const originTo = sessionCtx.OriginatingTo ?? sessionCtx.To;
  const rawProvider = config ? normalizeOptionalLowercaseString(originProvider) : undefined;
  if (!config || !rawProvider) {
    return {
      currentMessageId,
      currentSourceTurnId,
      replyToMode: sessionCtx.ReplyToMode,
    };
  }
  const provider = normalizeChatChannelId(rawProvider) ?? normalizeAnyChannelId(rawProvider);
  // Fallback for unrecognized/plugin channels (e.g., iMessage before plugin registry init)
  const threading = provider ? getChannelPlugin(provider)?.threading : undefined;
  const context: InternalChannelThreadingToolContext = threading?.buildToolContext
    ? (threading.buildToolContext({
        cfg: config,
        accountId: sessionCtx.AccountId,
        context: {
          Channel: originProvider,
          From: sessionCtx.From,
          To: originTo,
          ChatType: sessionCtx.ChatType,
          CurrentMessageId: currentMessageId,
          ReplyToMode: sessionCtx.ReplyToMode,
          ReplyToId: sessionCtx.ReplyToId,
          ReplyToIdFull: sessionCtx.ReplyToIdFull,
          ThreadLabel: sessionCtx.ThreadLabel,
          MessageThreadId: sessionCtx.MessageThreadId,
          TransportThreadId: sessionCtx.TransportThreadId,
          NativeChannelId: sessionCtx.NativeChannelId,
        },
        hasRepliedRef,
      }) ?? {})
    : { currentChannelId: normalizeOptionalString(originTo), hasRepliedRef };
  const hasAdapterCurrentMessageId = Object.hasOwn(context, "currentMessageId");
  return {
    ...context,
    currentChannelProvider: provider ?? (rawProvider as ChannelId),
    // Some providers expose only thread resources as reply targets; explicit
    // `undefined` means the adapter rejected the generic message-id fallback.
    currentMessageId: hasAdapterCurrentMessageId ? context.currentMessageId : currentMessageId,
    currentSourceTurnId,
    replyToMode: context.replyToMode ?? sessionCtx.ReplyToMode,
  };
}

export function resolveFollowupCurrentMessageId(queued: FollowupRun): string | undefined {
  return queued.run.inputProvenance?.kind === "internal_system" &&
    queued.run.inputProvenance.sourceTool === "restart-sentinel"
    ? queued.originatingReplyToId
    : queued.messageId;
}

/** Remaps the original inline request without reusing a queued model's clamped level. */
export function resolveRunThinkingLevelForFallbackCandidate(
  params: Omit<Parameters<typeof resolveCandidateThinkingLevel>[0], "level"> & {
    run: FollowupRun["run"];
  },
) {
  const { run, ...candidate } = params;
  return resolveCandidateThinkingLevel({
    ...candidate,
    // Reset and inherited choices already resolved defaults when this turn was admitted.
    level:
      run.thinkLevelOverride === "default"
        ? run.thinkLevel
        : (run.thinkLevelOverride ?? run.thinkLevel),
  });
}

export function resolveRunFastModeForFallbackCandidate(params: {
  run: FollowupRun["run"];
  config: OpenClawConfig;
  provider: string;
  model: string;
  sessionEntry?: Pick<SessionEntry, "fastMode">;
}) {
  const state = resolveFastModeState({
    cfg: params.config,
    provider: params.provider,
    model: params.model,
    agentId: params.run.agentId,
    sessionEntry: params.sessionEntry,
  });
  return {
    fastMode: params.run.fastModeOverride ? params.run.fastMode : state.mode,
    fastModeAutoOnSeconds: params.run.fastModeAutoOnSecondsOverride
      ? params.run.fastModeAutoOnSeconds
      : state.fastAutoOnSeconds,
  };
}
function applyReplyRouteToTemplate(params: {
  run: FollowupRun["run"];
  replyRoute?: EmbeddedReplyRoute;
  sessionCtx: TemplateContext;
}) {
  return {
    ...params.sessionCtx,
    OriginatingChannel:
      params.replyRoute?.originatingChannel ?? params.sessionCtx.OriginatingChannel,
    OriginatingTo: params.replyRoute?.originatingTo ?? params.sessionCtx.OriginatingTo,
    AccountId:
      params.replyRoute?.originatingAccountId ??
      params.sessionCtx.AccountId ??
      params.run.agentAccountId,
    ChatType:
      normalizeChatType(params.replyRoute?.originatingChatType) ??
      normalizeChatType(params.sessionCtx.ChatType) ??
      params.run.chatType,
    MessageThreadId: params.replyRoute?.originatingThreadId ?? params.sessionCtx.MessageThreadId,
    ReplyToId: params.replyRoute?.originatingReplyToId ?? params.sessionCtx.ReplyToId,
    ReplyToMode: params.replyRoute?.originatingReplyToMode ?? params.sessionCtx.ReplyToMode,
  };
}

/**
 * Builds message-tool threading context for the queued reply route. Embedded
 * and CLI runtimes share it so the channel adapter decides the default thread.
 */
export function buildReplyRouteThreadingToolContext(params: {
  run: FollowupRun["run"];
  replyRoute?: EmbeddedReplyRoute;
  sessionCtx: TemplateContext;
  hasRepliedRef: { value: boolean } | undefined;
}): InternalChannelThreadingToolContext {
  return buildThreadingToolContext({
    sessionCtx: applyReplyRouteToTemplate(params),
    config: params.run.config,
    hasRepliedRef: params.hasRepliedRef,
  });
}

function buildEmbeddedContextFromTemplate(params: {
  run: FollowupRun["run"];
  replyRoute?: EmbeddedReplyRoute;
  sessionCtx: TemplateContext;
  hasRepliedRef: { value: boolean } | undefined;
}) {
  const sessionCtx = applyReplyRouteToTemplate(params);
  return {
    sessionId: params.run.sessionId,
    sessionKey: params.run.sessionKey,
    sandboxSessionKey: params.run.runtimePolicySessionKey,
    agentId: params.run.agentId,
    messageProvider: resolveOriginMessageProvider({
      originatingChannel: sessionCtx.OriginatingChannel,
      provider: sessionCtx.Provider,
    }),
    ...(sessionCtx.ChatType ? { chatType: sessionCtx.ChatType } : {}),
    agentAccountId: sessionCtx.AccountId,
    conversationRoutePeerId: params.run.conversationRoutePeerId,
    messageTo: sessionCtx.OriginatingTo ?? sessionCtx.To,
    messageThreadId: sessionCtx.MessageThreadId ?? undefined,
    chatId:
      normalizeOptionalString(sessionCtx.NativeChannelId) ??
      normalizeOptionalString(sessionCtx.ChatId),
    memberRoleIds: normalizeOptionalTrimmedStringList(sessionCtx.MemberRoleIds),
    ...buildThreadingToolContext({
      sessionCtx,
      config: params.run.config,
      hasRepliedRef: params.hasRepliedRef,
    }),
    currentInboundAudio: hasInboundAudio(sessionCtx),
  };
}

function buildTemplateSenderContext(sessionCtx: TemplateContext) {
  return {
    senderId: normalizeOptionalString(sessionCtx.SenderId),
    channelContext: sessionCtx.ChannelContext,
    senderName: normalizeOptionalString(sessionCtx.SenderName),
    senderUsername: normalizeOptionalString(sessionCtx.SenderUsername),
    senderE164: normalizeOptionalString(sessionCtx.SenderE164),
  };
}

/** Bind either runtime to the same trusted source turn and requester. */
export function mintReplyMessageActionTurnCapability(
  turn: Pick<
    AgentTurnParams,
    "followupRun" | "sessionCtx" | "opts" | "isHeartbeat" | "runtimePolicySessionKey"
  >,
  runId: string,
): string | undefined {
  // An event's captured delivery route is not a new trusted channel turn.
  if (turn.followupRun.run.internalEventExecution) {
    return undefined;
  }
  const channelIngress = isTrustedMessageActionTurnIngress(turn.sessionCtx.Provider);
  const dashboardAdmission = turn.opts?.dashboardReadAdmission;
  if (turn.isHeartbeat || (!channelIngress && turn.sessionCtx.Provider !== "webchat")) {
    return undefined;
  }
  const context = buildEmbeddedContextFromTemplate({
    run: turn.followupRun.run,
    replyRoute: turn.followupRun,
    sessionCtx: turn.sessionCtx,
    hasRepliedRef: turn.opts?.hasRepliedRef,
  });
  const sessionKey = turn.runtimePolicySessionKey ?? context.sessionKey;
  if (!context.agentId || !sessionKey) {
    return undefined;
  }
  if (!channelIngress) {
    // Read permission stays tied to its original run. A queued prompt instead
    // brings its own native source custody, bound below to this new execution.
    const dashboard =
      dashboardAdmission?.runId === runId &&
      dashboardAdmission.agentId === context.agentId &&
      dashboardAdmission.sessionKey === sessionKey &&
      dashboardAdmission.sessionId === context.sessionId
        ? dashboardAdmission
        : undefined;
    const recorder = turn.followupRun.userTurnTranscriptRecorder;
    const source = readUserTurnPromptReactionSource(recorder);
    const promptSource =
      source && source.agentId === context.agentId && source.sessionKey === sessionKey
        ? source
        : undefined;
    if (!dashboard && !promptSource) {
      return undefined;
    }
    dashboard?.assertCurrent();
    promptSource?.assertCurrent();
    return mintMessageActionTurnCapability({
      agentId: context.agentId,
      runId,
      sessionKey,
      sessionId: context.sessionId,
      assertDashboardReadCurrent: dashboard?.assertCurrent,
      promptReactionSource:
        promptSource && recorder ? { source: promptSource, recorder } : undefined,
      expiresWithRun: true,
    });
  }
  if (!context.messageProvider || !context.currentChannelId) {
    return undefined;
  }
  const sender = buildTemplateSenderContext(turn.sessionCtx);
  return mintMessageActionTurnCapability({
    agentId: context.agentId,
    runId,
    sessionKey,
    sourceReplySessionKey: context.sessionKey,
    sessionId: context.sessionId,
    requesterAccountId: context.agentAccountId,
    requesterSenderId: sender.senderId,
    requesterSenderName: sender.senderName,
    requesterSenderUsername: sender.senderUsername,
    requesterSenderE164: sender.senderE164,
    toolContext: {
      currentChannelId: context.currentChannelId,
      currentChatType: context.chatType,
      currentMessagingTarget: context.currentMessagingTarget,
      currentGraphChannelId: context.currentGraphChannelId,
      currentChannelProvider: context.currentChannelProvider,
      currentThreadTs: context.currentThreadTs,
      currentMessageId: context.currentMessageId,
      currentSourceTurnId: context.currentSourceTurnId,
      replyToMode: context.replyToMode,
      hasRepliedRef: context.hasRepliedRef,
      sameChannelThreadRequired: context.sameChannelThreadRequired,
    },
    ...resolveMessageActionTurnCapabilityLifetime(turn.followupRun.run.timeoutMs),
  });
}

export async function buildEmbeddedRunExecutionParams(params: {
  run: FollowupRun["run"];
  replyRoute?: EmbeddedReplyRoute;
  sessionCtx: TemplateContext;
  hasRepliedRef: { value: boolean } | undefined;
  provider: string;
  model: string;
  agentRuntime?: string;
  runId: string;
  promptCacheKey?: string;
  allowTransientCooldownProbe?: boolean;
}) {
  const authProfile = resolveRunAuthProfile(params.run, params.provider);
  const embeddedContext = buildEmbeddedContextFromTemplate(params);
  const senderContext = buildTemplateSenderContext(params.sessionCtx);
  // Retain the base-input snapshot across thinking and vision discovery.
  const snapshot = { ...params };
  const config = snapshot.run.config;
  const { modelFallbackAvailability, fallbacksOverride: modelFallbacksOverride } =
    resolveModelFallbackOptions(snapshot.run);
  let modelThinkingCapability: PreparedModelThinkingCapability | undefined;
  if (snapshot.agentRuntime) {
    // Keep the lifecycle-owned catalog module lazy until this turn has a selected runtime.
    const { loadProviderScopedThinkingCatalog } =
      await import("../../agents/model-catalog.runtime.js");
    const observedCatalog = normalizeThinkingCatalogProviders(
      await loadProviderScopedThinkingCatalog({
        config,
        provider: snapshot.provider,
        model: snapshot.model,
        agentRuntime: snapshot.agentRuntime,
        agentId: snapshot.run.agentId,
        agentDir: snapshot.run.agentDir,
        workspaceDir: snapshot.run.workspaceDir,
      }),
    );
    const thinkingCatalog = findModelInCatalog(observedCatalog, snapshot.provider, snapshot.model)
      ? observedCatalog
      : snapshot.run.thinkingCatalog;
    modelThinkingCapability = prepareModelRunCapabilities(
      [thinkingCatalog, []],
      [snapshot.provider, snapshot.model, snapshot.agentRuntime],
    ).modelThinkingCapability;
  }
  const enforceFinalTag =
    !snapshot.run.skipProviderRuntimeHints &&
    (snapshot.run.enforceFinalTag ||
      isReasoningTagProvider(snapshot.provider, {
        config,
        workspaceDir: snapshot.run.workspaceDir,
        modelId: snapshot.model,
      }));
  // Runtime policy keys may differ from session keys for direct-message scoped policy.
  return {
    ...embeddedContext,
    ...senderContext,
    ...buildReplyRunStateParams(snapshot.run),
    providerReviewAcknowledgment: snapshot.run.providerReviewAcknowledgment,
    permissionMode: snapshot.run.permissionMode,
    sessionRoot: snapshot.run.sessionRoot,
    agentDir: snapshot.run.agentDir,
    config,
    trustedInternalHandoff: snapshot.run.trustedInternalHandoff,
    scheduledToolPolicy: snapshot.run.scheduledToolPolicy,
    runtimePluginToolGrant: snapshot.run.runtimePluginToolGrant,
    enforceFinalTag,
    silentExpected: snapshot.run.silentExpected,
    silentReplyPromptMode: snapshot.run.silentReplyPromptMode,
    sourceReplyDeliveryMode: snapshot.run.sourceReplyDeliveryMode,
    toolBindings: snapshot.run.toolBindings,
    skillLibraryAuthoring: snapshot.run.skillLibraryAuthoring,
    provider: snapshot.provider,
    model: snapshot.model,
    modelHasVision: await resolveRunModelHasVision(snapshot),
    ...(modelThinkingCapability ? { modelThinkingCapability } : {}),
    requestedRouteResolution: "resolved" as const,
    modelSelectionLocked: snapshot.run.modelSelectionLocked,
    modelFallbackAvailability,
    modelFallbacksOverride,
    ...authProfile,
    thinkLevel: snapshot.run.thinkLevel,
    fastMode: snapshot.run.fastMode,
    fastModeAutoOnSeconds: snapshot.run.fastModeAutoOnSeconds,
    verboseLevel: snapshot.run.verboseLevel,
    reasoningLevel: snapshot.run.reasoningLevel,
    execOverrides: snapshot.run.execOverrides,
    bashElevated: snapshot.run.bashElevated,
    timeoutMs: snapshot.run.timeoutMs,
    runTimeoutOverrideMs: snapshot.run.runTimeoutOverrideMs,
    runId: snapshot.runId,
    promptCacheKey: snapshot.promptCacheKey,
    allowTransientCooldownProbe: snapshot.allowTransientCooldownProbe,
  };
}
