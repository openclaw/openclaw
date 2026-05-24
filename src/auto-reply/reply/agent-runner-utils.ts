import { getChannelPlugin } from "../../channels/plugins/index.js";
import type {
  ChannelId,
  ChannelThreadingToolContext,
} from "../../channels/plugins/types.public.js";
import { normalizeAnyChannelId, normalizeChannelId } from "../../channels/registry.js";
import { resolveCommandSecretRefsViaGateway } from "../../cli/command-secret-gateway.js";
import {
  getAgentRuntimeCommandSecretTargetIds,
  getScopedChannelsCommandSecretTargets,
} from "../../cli/command-secret-targets.js";
import { resolveMessageSecretScope } from "../../cli/message-secret-scope.js";
import {
  getRuntimeConfigSnapshot,
  getRuntimeConfigSourceSnapshot,
  selectApplicableRuntimeConfig,
  type OpenClawConfig,
} from "../../config/config.js";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";
import { isReasoningTagProvider } from "../../utils/provider-utils.js";
import type { TemplateContext } from "../templating.js";
import {
  resolveProviderScopedAuthProfile,
  resolveRunAuthProfile,
} from "./agent-runner-auth-profile.js";
export { resolveProviderScopedAuthProfile, resolveRunAuthProfile };
import {
  buildEmbeddedRunBaseParams as buildEmbeddedRunBaseParamsCore,
  resolveEnforceFinalTagWithResolver,
} from "./agent-runner-run-params.js";
export { resolveModelFallbackOptions } from "./agent-runner-run-params.js";
import { resolveOriginMessageProvider, resolveOriginMessageTo } from "./origin-routing.js";
import type { FollowupRun } from "./queue.js";

const BUN_FETCH_SOCKET_ERROR_RE = /socket connection was closed unexpectedly/i;
const QUEUED_REPLY_EXECUTION_CONFIG_CACHE = Symbol.for("openclaw.queuedReplyExecutionConfigCache");
const QUEUED_REPLY_EXECUTION_CONFIG_CACHE_TTL_MS = 60_000;

type QueuedReplyExecutionConfigCache = {
  weak: WeakMap<OpenClawConfig, Map<string, { createdAt: number; config: OpenClawConfig }>>;
  primitive: Map<string, { createdAt: number; config: OpenClawConfig }>;
};

function getQueuedReplyExecutionConfigCache(): QueuedReplyExecutionConfigCache {
  const globalState = globalThis as typeof globalThis & {
    [QUEUED_REPLY_EXECUTION_CONFIG_CACHE]?: QueuedReplyExecutionConfigCache;
  };
  const existing = globalState[QUEUED_REPLY_EXECUTION_CONFIG_CACHE];
  if (existing?.weak instanceof WeakMap && existing.primitive instanceof Map) {
    return existing;
  }
  const next: QueuedReplyExecutionConfigCache = {
    weak: new WeakMap(),
    primitive: new Map(),
  };
  globalState[QUEUED_REPLY_EXECUTION_CONFIG_CACHE] = next;
  return next;
}

function buildQueuedReplyExecutionConfigCacheKey(params?: {
  originatingChannel?: string;
  messageProvider?: string;
  originatingAccountId?: string;
  agentAccountId?: string;
}): string {
  return JSON.stringify({
    originatingChannel: params?.originatingChannel,
    messageProvider: params?.messageProvider,
    originatingAccountId: params?.originatingAccountId,
    agentAccountId: params?.agentAccountId,
  });
}

function readQueuedReplyExecutionConfigCache(
  config: OpenClawConfig,
  key: string,
): OpenClawConfig | undefined {
  const cache = getQueuedReplyExecutionConfigCache();
  const entry =
    typeof config === "object" && config !== null
      ? cache.weak.get(config)?.get(key)
      : cache.primitive.get(key);
  if (!entry || Date.now() - entry.createdAt > QUEUED_REPLY_EXECUTION_CONFIG_CACHE_TTL_MS) {
    return undefined;
  }
  return entry.config;
}

function writeQueuedReplyExecutionConfigCache(
  config: OpenClawConfig,
  key: string,
  resolvedConfig: OpenClawConfig,
): void {
  const cache = getQueuedReplyExecutionConfigCache();
  const entry = { createdAt: Date.now(), config: resolvedConfig };
  if (typeof config === "object" && config !== null) {
    const existing = cache.weak.get(config);
    if (existing) {
      existing.set(key, entry);
    } else {
      cache.weak.set(config, new Map([[key, entry]]));
    }
    return;
  }
  cache.primitive.set(key, entry);
}

export function resolveQueuedReplyRuntimeConfig(config: OpenClawConfig): OpenClawConfig {
  const runtimeConfig =
    typeof getRuntimeConfigSnapshot === "function" ? getRuntimeConfigSnapshot() : null;
  const runtimeSourceConfig =
    typeof getRuntimeConfigSourceSnapshot === "function" ? getRuntimeConfigSourceSnapshot() : null;
  return (
    selectApplicableRuntimeConfig({
      inputConfig: config,
      runtimeConfig,
      runtimeSourceConfig,
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
  const cacheKey = buildQueuedReplyExecutionConfigCacheKey(params);
  const cached = readQueuedReplyExecutionConfigCache(config, cacheKey);
  if (cached) {
    return cached;
  }
  const runtimeConfig = resolveQueuedReplyRuntimeConfig(config);
  const { resolvedConfig } = await resolveCommandSecretRefsViaGateway({
    config: runtimeConfig,
    commandName: "reply",
    targetIds: getAgentRuntimeCommandSecretTargetIds(),
  });
  const baseResolvedConfig = resolvedConfig ?? runtimeConfig;

  const scope = resolveMessageSecretScope({
    channel: params?.originatingChannel,
    fallbackChannel: params?.messageProvider,
    accountId: params?.originatingAccountId,
    fallbackAccountId: params?.agentAccountId,
  });
  if (!scope.channel) {
    writeQueuedReplyExecutionConfigCache(config, cacheKey, baseResolvedConfig);
    return baseResolvedConfig;
  }

  const scopedTargets = getScopedChannelsCommandSecretTargets({
    config: baseResolvedConfig,
    channel: scope.channel,
    accountId: scope.accountId,
  });
  if (scopedTargets.targetIds.size === 0) {
    writeQueuedReplyExecutionConfigCache(config, cacheKey, baseResolvedConfig);
    return baseResolvedConfig;
  }

  const scopedResolved = await resolveCommandSecretRefsViaGateway({
    config: baseResolvedConfig,
    commandName: "reply",
    targetIds: scopedTargets.targetIds,
    ...(scopedTargets.allowedPaths ? { allowedPaths: scopedTargets.allowedPaths } : {}),
  });
  const finalConfig = scopedResolved.resolvedConfig ?? baseResolvedConfig;
  writeQueuedReplyExecutionConfigCache(config, cacheKey, finalConfig);
  return finalConfig;
}

/**
 * Build provider-specific threading context for tool auto-injection.
 */
export function buildThreadingToolContext(params: {
  sessionCtx: TemplateContext;
  config: OpenClawConfig | undefined;
  hasRepliedRef: { value: boolean } | undefined;
}): ChannelThreadingToolContext {
  const { sessionCtx, config, hasRepliedRef } = params;
  const currentMessageId = sessionCtx.MessageSidFull ?? sessionCtx.MessageSid;
  const originProvider = resolveOriginMessageProvider({
    originatingChannel: sessionCtx.OriginatingChannel,
    provider: sessionCtx.Provider,
  });
  const originTo = resolveOriginMessageTo({
    originatingTo: sessionCtx.OriginatingTo,
    to: sessionCtx.To,
  });
  if (!config) {
    return {
      currentMessageId,
    };
  }
  const rawProvider = normalizeOptionalLowercaseString(originProvider);
  if (!rawProvider) {
    return {
      currentMessageId,
    };
  }
  const provider = normalizeChannelId(rawProvider) ?? normalizeAnyChannelId(rawProvider);
  // Fallback for unrecognized/plugin channels (e.g., iMessage before plugin registry init)
  const threading = provider ? getChannelPlugin(provider)?.threading : undefined;
  if (!threading?.buildToolContext) {
    return {
      currentChannelId: normalizeOptionalString(originTo),
      currentChannelProvider: provider ?? (rawProvider as ChannelId),
      currentMessageId,
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
        ReplyToId: sessionCtx.ReplyToId,
        ThreadLabel: sessionCtx.ThreadLabel,
        MessageThreadId: sessionCtx.MessageThreadId,
        TransportThreadId: sessionCtx.TransportThreadId,
        NativeChannelId: sessionCtx.NativeChannelId,
      },
      hasRepliedRef,
    }) ?? {};
  return {
    ...context,
    currentChannelProvider: provider!, // guaranteed non-null since threading exists
    currentMessageId: context.currentMessageId ?? currentMessageId,
  };
}

export const isBunFetchSocketError = (message?: string) =>
  message ? BUN_FETCH_SOCKET_ERROR_RE.test(message) : false;

export const formatBunFetchSocketError = (message: string) => {
  const trimmed = message.trim();
  return [
    "⚠️ LLM connection failed. This could be due to server issues, network problems, or context length exceeded (e.g., with local LLMs like LM Studio). Original error:",
    "```",
    trimmed || "Unknown error",
    "```",
  ].join("\n");
};

export const testing = {
  resetQueuedReplyExecutionConfigCache() {
    const cache = getQueuedReplyExecutionConfigCache();
    cache.primitive.clear();
    // WeakMap entries are not iterable; replacing the global cache clears them.
    const globalState = globalThis as typeof globalThis & {
      [QUEUED_REPLY_EXECUTION_CONFIG_CACHE]?: QueuedReplyExecutionConfigCache;
    };
    globalState[QUEUED_REPLY_EXECUTION_CONFIG_CACHE] = {
      weak: new WeakMap(),
      primitive: new Map(),
    };
  },
};

export const resolveEnforceFinalTag = (
  run: FollowupRun["run"],
  provider: string,
  model = run.model,
) => resolveEnforceFinalTagWithResolver(run, provider, model, isReasoningTagProvider);

export function buildEmbeddedRunBaseParams(
  params: Parameters<typeof buildEmbeddedRunBaseParamsCore>[0],
) {
  return buildEmbeddedRunBaseParamsCore({
    ...params,
    isReasoningTagProvider,
  });
}

function buildEmbeddedContextFromTemplate(params: {
  run: FollowupRun["run"];
  sessionCtx: TemplateContext;
  hasRepliedRef: { value: boolean } | undefined;
}) {
  const config = params.run.config;
  return {
    sessionId: params.run.sessionId,
    sessionKey: params.run.sessionKey,
    sandboxSessionKey: params.run.runtimePolicySessionKey,
    agentId: params.run.agentId,
    messageProvider: resolveOriginMessageProvider({
      originatingChannel: params.sessionCtx.OriginatingChannel,
      provider: params.sessionCtx.Provider,
    }),
    agentAccountId: params.sessionCtx.AccountId,
    messageTo: resolveOriginMessageTo({
      originatingTo: params.sessionCtx.OriginatingTo,
      to: params.sessionCtx.To,
    }),
    messageThreadId: params.sessionCtx.MessageThreadId ?? undefined,
    memberRoleIds: normalizeMemberRoleIds(params.sessionCtx.MemberRoleIds),
    // Provider threading context for tool auto-injection
    ...buildThreadingToolContext({
      sessionCtx: params.sessionCtx,
      config,
      hasRepliedRef: params.hasRepliedRef,
    }),
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
    senderName: normalizeOptionalString(sessionCtx.SenderName),
    senderUsername: normalizeOptionalString(sessionCtx.SenderUsername),
    senderE164: normalizeOptionalString(sessionCtx.SenderE164),
  };
}

export function buildEmbeddedRunContexts(params: {
  run: FollowupRun["run"];
  sessionCtx: TemplateContext;
  hasRepliedRef: { value: boolean } | undefined;
  provider: string;
}) {
  return {
    authProfile: resolveRunAuthProfile(params.run, params.provider),
    embeddedContext: buildEmbeddedContextFromTemplate({
      run: params.run,
      sessionCtx: params.sessionCtx,
      hasRepliedRef: params.hasRepliedRef,
    }),
    senderContext: buildTemplateSenderContext(params.sessionCtx),
  };
}

export function buildEmbeddedRunExecutionParams(params: {
  run: FollowupRun["run"];
  sessionCtx: TemplateContext;
  hasRepliedRef: { value: boolean } | undefined;
  provider: string;
  model: string;
  runId: string;
  allowTransientCooldownProbe?: boolean;
}) {
  const { authProfile, embeddedContext, senderContext } = buildEmbeddedRunContexts(params);
  const runBaseParams = buildEmbeddedRunBaseParams({
    run: params.run,
    provider: params.provider,
    model: params.model,
    runId: params.runId,
    authProfile,
    allowTransientCooldownProbe: params.allowTransientCooldownProbe,
  });
  return {
    embeddedContext,
    senderContext,
    runBaseParams,
  };
}
