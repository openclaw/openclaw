/** Utilities for queued reply runtime config, auth, threading, and embedded run params. */
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { resolveFastModeState } from "../../agents/fast-mode.js";
import { resolveCandidateThinkingLevel } from "../../agents/thinking-runtime.js";
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
import type { TemplateContext } from "../templating.js";
import { resolveRunAuthProfile } from "./agent-runner-auth-profile.js";
import type { AgentTurnParams } from "./agent-runner-execution.types.js";
import { buildEmbeddedRunBaseParams } from "./agent-runner-run-params.js";
import { hasInboundAudio } from "./inbound-media.js";
import { resolveOriginMessageProvider } from "./origin-routing.js";
import type { FollowupRun } from "./queue.js";
import { readChannelSourceTurnId } from "./source-turn-id.js";
export { resolveModelFallbackOptions } from "./agent-runner-run-params.js";

const BUN_FETCH_SOCKET_ERROR_RE = /socket connection was closed unexpectedly/i;
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

/** Selects the freshest runtime config usable by queued reply execution. */
export function resolveQueuedReplyRuntimeConfig(config: OpenClawConfig): OpenClawConfig {
  return (
    selectApplicableRuntimeConfig({
      inputConfig: config,
      runtimeConfig: getRuntimeConfigSnapshot(),
      runtimeSourceConfig: getRuntimeConfigSourceSnapshot(),
    }) ?? config
  );
}

/** Resolves command secrets for queued reply execution, scoped to the origin route. */
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

/** Builds channel threading context for message-tool replies. */
export function buildThreadingToolContext(params: {
  sessionCtx: TemplateContext;
  config: OpenClawConfig | undefined;
  hasRepliedRef: { value: boolean } | undefined;
}): InternalChannelThreadingToolContext {
  const { sessionCtx, config, hasRepliedRef } = params;
  const isRestartSentinelContinuation =
    sessionCtx.InputProvenance?.kind === "internal_system" &&
    sessionCtx.InputProvenance.sourceTool === "restart-sentinel";
  const currentMessageId = isRestartSentinelContinuation
    ? sessionCtx.ReplyToId
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
  if (!threading?.buildToolContext) {
    return {
      currentChannelId: normalizeOptionalString(originTo),
      currentChannelProvider: provider ?? (rawProvider as ChannelId),
      currentMessageId,
      currentSourceTurnId,
      replyToMode: sessionCtx.ReplyToMode,
      hasRepliedRef,
    };
  }
  const context =
    threading.buildToolContext({
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
    }) ?? {};
  const hasAdapterCurrentMessageId = Object.hasOwn(context, "currentMessageId");
  return {
    ...context,
    currentChannelProvider: provider!, // guaranteed non-null since threading exists
    // Some providers expose only thread resources as reply targets; explicit
    // `undefined` means the adapter rejected the generic message-id fallback.
    currentMessageId: hasAdapterCurrentMessageId ? context.currentMessageId : currentMessageId,
    currentSourceTurnId,
    replyToMode: context.replyToMode ?? sessionCtx.ReplyToMode,
  };
}

/** Detects Bun socket-close errors that should be formatted more clearly. */
export const isBunFetchSocketError = (message?: string) =>
  message ? BUN_FETCH_SOCKET_ERROR_RE.test(message) : false;

/** Formats Bun socket-close errors for user-facing reply output. */
export const formatBunFetchSocketError = (message: string) => {
  const trimmed = message.trim();
  return [
    "⚠️ LLM connection failed. This could be due to server issues, network problems, or context length exceeded (e.g., with local LLMs like LM Studio). Original error:",
    "```",
    trimmed || "Unknown error",
    "```",
  ].join("\n");
};

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

/** Resolves candidate-scoped fast mode after model fallback changes provider/model. */
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
function buildEmbeddedContextFromTemplate(params: {
  run: FollowupRun["run"];
  replyRoute?: EmbeddedReplyRoute;
  sessionCtx: TemplateContext;
  hasRepliedRef: { value: boolean } | undefined;
}) {
  const config = params.run.config;
  const sessionCtx = {
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
    memberRoleIds: normalizeMemberRoleIds(sessionCtx.MemberRoleIds),
    // Provider threading context for tool auto-injection
    ...buildThreadingToolContext({
      sessionCtx,
      config,
      hasRepliedRef: params.hasRepliedRef,
    }),
    currentInboundAudio: hasInboundAudio(sessionCtx),
  };
}

function normalizeMemberRoleIds(value: TemplateContext["MemberRoleIds"]): string[] | undefined {
  const roles = Array.isArray(value)
    ? value
        .map((roleId) => normalizeOptionalString(roleId))
        .filter((roleId): roleId is string => Boolean(roleId))
    : [];
  return roles.length > 0 ? roles : undefined;
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
  const channelIngress = isTrustedMessageActionTurnIngress(turn.sessionCtx.Provider);
  const dashboardAdmission = turn.opts?.dashboardReadAdmission;
  if (
    turn.isHeartbeat ||
    (!channelIngress &&
      (turn.sessionCtx.Provider !== "webchat" || dashboardAdmission?.runId !== runId))
  ) {
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
    // Queue options may come from another input. Match the original admission,
    // not opts.runId, which followup execution replaces with its own run ID.
    if (
      !dashboardAdmission ||
      dashboardAdmission.agentId !== context.agentId ||
      dashboardAdmission.sessionKey !== sessionKey ||
      dashboardAdmission.sessionId !== context.sessionId
    ) {
      return undefined;
    }
    dashboardAdmission.assertCurrent();
    return mintMessageActionTurnCapability({
      agentId: context.agentId,
      runId,
      sessionKey,
      sessionId: context.sessionId,
      assertDashboardReadCurrent: dashboardAdmission.assertCurrent,
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

/** Builds execution-specific embedded run params for queued reply dispatch. */
export async function buildEmbeddedRunExecutionParams(params: {
  run: FollowupRun["run"];
  replyRoute?: EmbeddedReplyRoute;
  sessionCtx: TemplateContext;
  hasRepliedRef: { value: boolean } | undefined;
  provider: string;
  model: string;
  runId: string;
  promptCacheKey?: string;
  allowTransientCooldownProbe?: boolean;
}) {
  const authProfile = resolveRunAuthProfile(params.run, params.provider);
  const embeddedContext = buildEmbeddedContextFromTemplate({
    run: params.run,
    replyRoute: params.replyRoute,
    sessionCtx: params.sessionCtx,
    hasRepliedRef: params.hasRepliedRef,
  });
  const senderContext = buildTemplateSenderContext(params.sessionCtx);
  const runBaseParams = await buildEmbeddedRunBaseParams({
    run: params.run,
    provider: params.provider,
    model: params.model,
    runId: params.runId,
    promptCacheKey: params.promptCacheKey,
    authProfile,
    allowTransientCooldownProbe: params.allowTransientCooldownProbe,
  });
  return {
    embeddedContext,
    senderContext,
    runBaseParams,
  };
}
