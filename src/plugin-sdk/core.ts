/**
 * Plugin SDK 核心模块
 * 
 * 本模块是 OpenClaw Plugin SDK 的核心入口，提供了插件开发所需的所有类型定义
 * 和辅助函数。包括配置 schema、聊天渠道元数据、通道插件构建器等功能。
 */

// 导入持久化绑定相关类型
import type { ResolvedConfiguredAcpBinding } from "../acp/persistent-bindings.types.js";
// 导入聊天渠道元数据构建函数
import { buildChatChannelMetaById } from "../channels/chat-meta-shared.js";
// 导入聊天渠道 ID 类型
import type { ChatChannelId } from "../channels/ids.js";
// 导入空渠道配置 schema
import { emptyChannelConfigSchema } from "../channels/plugins/config-schema.js";
// 导入账户作用域 DM 安全策略构建函数
import { buildAccountScopedDmSecurityPolicy } from "../channels/plugins/helpers.js";
// 导入回复模式解析函数
import {
  createScopedAccountReplyToModeResolver,
  createTopLevelChannelReplyToModeResolver,
} from "../channels/plugins/threading-helpers.js";
// 导入渠道适配器类型
import type {
  ChannelOutboundAdapter,
  ChannelPairingAdapter,
  ChannelSecurityAdapter,
} from "../channels/plugins/types.adapters.js";
// 导入渠道配置 schema 类型
import type { ChannelConfigSchema, ChannelConfigUiHint } from "../channels/plugins/types.config.js";
// 导入渠道核心类型
import type {
  ChannelMessagingAdapter,
  ChannelOutboundSessionRoute,
  ChannelPollResult,
  ChannelThreadingAdapter,
} from "../channels/plugins/types.core.js";
// 导入渠道插件类型
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
// 导入渠道元数据类型
import type { ChannelMeta } from "../channels/plugins/types.public.js";
// 导入回复模式类型
import type { ReplyToMode } from "../config/types.base.js";
// 导入 OpenClaw 配置类型
import type { OpenClawConfig } from "../config/types.openclaw.js";
// 导入出站基础会话键构建函数
import { buildOutboundBaseSessionKey } from "../infra/outbound/base-session-key.js";
// 导入出站投递结果类型
import type { OutboundDeliveryResult } from "../infra/outbound/deliver.js";
// 导入出站线程 ID 规范化函数
import { normalizeOutboundThreadId } from "../infra/outbound/thread-id.js";
// 导入捆绑插件目录解析函数
import { resolveBundledPluginsDir } from "../plugins/bundled-dir.js";
// 导入 Provider 运行时模型类型
import type { ProviderRuntimeModel } from "../plugins/provider-runtime-model.types.js";
// 导入插件运行时类型
import type { PluginRuntime } from "../plugins/runtime/types.js";
// 导入 OpenClaw 插件 API 类型
import type { OpenClawPluginApi } from "../plugins/types.js";
// 导入线程会话键解析函数
import { resolveThreadSessionKeys } from "../routing/session-key.js";
// 导入解析线程会话后缀函数
import { parseThreadSessionSuffix } from "../sessions/session-key-utils.js";
// 导入字符串规范化函数
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "../shared/string-coerce.js";

// ============ 类型导出 ============

// 从 plugin-entry 重新导出所有类型
export type {
  AgentHarness,
  AnyAgentTool,
  MediaUnderstandingProviderPlugin,
  OpenClawPluginApi,
  OpenClawPluginCommandDefinition,
  OpenClawPluginConfigSchema,
  OpenClawPluginDefinition,
  OpenClawPluginService,
  OpenClawPluginServiceContext,
  PluginCommandContext,
  PluginCommandResult,
  PluginAgentEventSubscriptionRegistration,
  PluginAgentTurnPrepareEvent,
  PluginAgentTurnPrepareResult,
  PluginControlUiDescriptor,
  PluginHeartbeatPromptContributionEvent,
  PluginHeartbeatPromptContributionResult,
  PluginJsonValue,
  PluginNextTurnInjection,
  PluginNextTurnInjectionEnqueueResult,
  PluginNextTurnInjectionRecord,
  PluginRunContextGetParams,
  PluginRunContextPatch,
  PluginRuntimeLifecycleRegistration,
  PluginSessionSchedulerJobHandle,
  PluginSessionSchedulerJobRegistration,
  PluginSessionExtensionRegistration,
  PluginSessionExtensionProjection,
  PluginToolMetadataRegistration,
  PluginTrustedToolPolicyRegistration,
  PluginLogger,
  ProviderAuthContext,
  ProviderAuthDoctorHintContext,
  ProviderAuthMethod,
  ProviderAuthMethodNonInteractiveContext,
  ProviderAuthResult,
  ProviderAugmentModelCatalogContext,
  ProviderBuildMissingAuthMessageContext,
  ProviderBuildUnknownModelHintContext,
  ProviderBuiltInModelSuppressionContext,
  ProviderBuiltInModelSuppressionResult,
  ProviderCacheTtlEligibilityContext,
  ProviderCatalogContext,
  ProviderCatalogResult,
  ProviderDefaultThinkingPolicyContext,
  ProviderDiscoveryContext,
  ProviderFetchUsageSnapshotContext,
  ProviderModernModelPolicyContext,
  ProviderNormalizeResolvedModelContext,
  ProviderNormalizeToolSchemasContext,
  ProviderPrepareDynamicModelContext,
  ProviderPrepareExtraParamsContext,
  ProviderPrepareRuntimeAuthContext,
  ProviderPreparedRuntimeAuth,
  ProviderReasoningOutputMode,
  ProviderReasoningOutputModeContext,
  ProviderReplayPolicy,
  ProviderReplayPolicyContext,
  ProviderReplaySessionEntry,
  ProviderReplaySessionState,
  ProviderResolveDynamicModelContext,
  ProviderResolveTransportTurnStateContext,
  ProviderResolveWebSocketSessionPolicyContext,
  ProviderResolvedUsageAuth,
  RealtimeTranscriptionProviderPlugin,
  ProviderSanitizeReplayHistoryContext,
  ProviderTransportTurnState,
  ProviderToolSchemaDiagnostic,
  ProviderResolveUsageAuthContext,
  ProviderThinkingProfile,
  ProviderThinkingPolicyContext,
  ProviderValidateReplayTurnsContext,
  ProviderWebSocketSessionPolicy,
  ProviderWrapStreamFnContext,
  SpeechProviderPlugin,
} from "./plugin-entry.js";

// 重新导出 Provider 运行时模型类型
export type { ProviderRuntimeModel } from "../plugins/provider-runtime-model.types.js";
// 重新导出工具相关类型
export type { OpenClawPluginToolContext, OpenClawPluginToolFactory } from "../plugins/types.js";
// 重新导出记忆插件能力类型
export type {
  MemoryPluginCapability,
  MemoryPluginPublicArtifact,
  MemoryPluginPublicArtifactsProvider,
} from "../plugins/memory-state.js";
// 重新导出钩子相关类型
export type {
  PluginHookReplyDispatchContext,
  PluginHookReplyDispatchEvent,
  PluginHookReplyDispatchResult,
} from "../plugins/types.js";
// 重新导出 OpenClaw 配置类型
export type { OpenClawConfig } from "../config/config.js";
// 重新导出出站身份类型
export type { OutboundIdentity } from "../infra/outbound/identity.js";
// 重新导出历史条目类型
export type { HistoryEntry } from "../auto-reply/reply/history.js";
// 重新导出回复载荷类型
export type { ReplyPayload } from "./reply-payload.js";
// 重新导出允许列表匹配类型
export type { AllowlistMatch } from "../channels/allowlist-match.js";
// 重新导出渠道相关公共类型
export type {
  BaseProbeResult,
  ChannelAccountSnapshot,
  ChannelGroupContext,
  ChannelMessageActionName,
  ChannelMeta,
  ChannelSetupInput,
} from "../channels/plugins/types.public.js";
// 重新导出聊天类型
export type { ChatType } from "../channels/chat-type.js";
// 重新导出位置类型
export type { NormalizedLocation } from "../channels/location.js";
// 重新导出渠道目录条目类型
export type { ChannelDirectoryEntry } from "../channels/plugins/types.core.js";
// 重新导出渠道出站适配器类型
export type { ChannelOutboundAdapter } from "../channels/plugins/types.adapters.js";
// 重新导出轮询输入类型
export type { PollInput } from "../polls.js";
// 重新导出密钥引用判断函数
export { isSecretRef } from "../config/types.secrets.js";
// 重新导出网关请求处理器选项类型
export type { GatewayRequestHandlerOptions } from "../gateway/server-methods/types.js";
// 重新导出渠道消息适配器和出站会话路由类型
export type {
  ChannelOutboundSessionRoute,
  ChannelMessagingAdapter,
} from "../channels/plugins/types.core.js";

// ============ 类型定义 ============

/**
 * 创建内联文本配对适配器
 * 用于创建简单的文本通知配对适配器
 * @param params - 包含 idLabel、message 和可选的 normalizeAllowEntry、notify 函数
 * @returns 渠道配对适配器
 */
function createInlineTextPairingAdapter(params: {
  idLabel: string;
  message: string;
  normalizeAllowEntry?: ChannelPairingAdapter["normalizeAllowEntry"];
  notify: (
    params: Parameters<NonNullable<ChannelPairingAdapter["notifyApproval"]>>[0] & {
      message: string;
    },
  ) => Promise<void> | void;
}): ChannelPairingAdapter {
  return {
    idLabel: params.idLabel,
    normalizeAllowEntry: params.normalizeAllowEntry,
    notifyApproval: async (ctx) => {
      await params.notify({ ...ctx, message: params.message });
    },
  };
}

// 重新导出使用量快照相关类型
export type {
  ProviderUsageSnapshot,
  UsageProviderId,
  UsageWindow,
} from "../infra/provider-usage.types.js";
// 重新导出渠道消息动作上下文类型
export type { ChannelMessageActionContext } from "../channels/plugins/types.public.js";
// 重新导出渠道插件类型
export type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
// 重新导出渠道配置 UI 提示类型
export type { ChannelConfigUiHint } from "../channels/plugins/types.config.js";
// 重新导出插件运行时和运行时日志类型
export type { PluginRuntime, RuntimeLogger } from "../plugins/runtime/types.js";
// 重新导出向导提示类型
export type { WizardPrompter } from "../wizard/prompts.js";

// ============ 函数导出 ============

// 从 plugin-entry 重新导出 definePluginEntry
export { definePluginEntry } from "./plugin-entry.js";
// 重新导出插件配置 schema 构建函数
export { buildPluginConfigSchema, emptyPluginConfigSchema } from "../plugins/config-schema.js";
// 重新导出键控异步队列相关
export { KeyedAsyncQueue, enqueueKeyedTask } from "./keyed-async-queue.js";
// 重新导出去重缓存相关
export { createDedupeCache, resolveGlobalDedupeCache } from "../infra/dedupe.js";
// 重新导出安全令牌和 UUID 生成
export { generateSecureToken, generateSecureUuid } from "../infra/secure-random.js";
// 重新导出记忆系统提示和压缩委托相关
export {
  buildMemorySystemPromptAddition,
  delegateCompactionToRuntime,
} from "../context-engine/delegate.js";
// 重新导出默认账户 ID 和规范化函数
export { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../routing/session-key.js";
// 重新导出渠道配置 schema 构建函数
export {
  buildChannelConfigSchema,
  emptyChannelConfigSchema,
} from "../channels/plugins/config-schema.js";
// 重新导出渠道设置辅助函数
export {
  applyAccountNameToChannelSection,
  migrateBaseNameToDefaultAccount,
} from "../channels/plugins/setup-helpers.js";
// 重新导出渠道配置辅助函数
export {
  clearAccountEntryFields,
  deleteAccountFromConfigSection,
  setAccountEnabledInConfigSection,
} from "../channels/plugins/config-helpers.js";
// 重新导出配对提示和解析辅助函数
export {
  formatPairingApproveHint,
  parseOptionalDelimitedEntries,
} from "../channels/plugins/helpers.js";
// 重新导出 schema 类型
export {
  channelTargetSchema,
  channelTargetsSchema,
  optionalStringEnum,
  stringEnum,
} from "../agents/schema/typebox.js";
// 重新导出密钥文件相关函数
export {
  DEFAULT_SECRET_FILE_MAX_BYTES,
  loadSecretFileSync,
  readSecretFileSync,
  tryReadSecretFileSync,
} from "../infra/secret-file.js";
// 重新导出密钥文件类型
export type { SecretFileReadOptions, SecretFileReadResult } from "../infra/secret-file.js";

// 重新导出网关绑定 URL 解析函数
export { resolveGatewayBindUrl } from "../shared/gateway-bind-url.js";
// 重新导出网关绑定 URL 结果类型
export type { GatewayBindUrlResult } from "../shared/gateway-bind-url.js";
// 重新导出网关端口解析函数
export { resolveGatewayPort } from "../config/paths.js";
// 重新导出子系统日志创建函数
export { createSubsystemLogger } from "../logging/subsystem.js";
// 重新导出字符串规范化函数
export { normalizeAtHashSlug, normalizeHyphenSlug } from "../shared/string-normalization.js";
// 重新导出动作门创建函数
export { createActionGate } from "../agents/tools/common.js";
// 重新导出 JSON 结果和参数读取函数
export {
  jsonResult,
  readNumberParam,
  readReactionParams,
  readStringArrayParam,
  readStringParam,
} from "../agents/tools/common.js";
// 重新导出解析正整数函数
export { parseStrictPositiveInteger } from "../infra/parse-finite-number.js";
// 重新导出代理地址信任判断和客户端 IP 解析函数
export { isTrustedProxyAddress, resolveClientIp } from "../gateway/net.js";
// 重新导出带时区时间戳格式化函数
export { formatZonedTimestamp } from "../infra/format-time/format-datetime.js";
// 重新导出配置的 ACP 绑定记录解析函数
export { resolveConfiguredAcpBindingRecord } from "../acp/persistent-bindings.resolve.js";

// ============ 异步函数导出 ============

/**
 * 确保配置的 ACP 绑定就绪
 * @param params - 包含配置和已解析绑定的对象
 * @returns 成功或失败结果
 */
export async function ensureConfiguredAcpBindingReady(params: {
  cfg: OpenClawConfig;
  configuredBinding: ResolvedConfiguredAcpBinding | null;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const runtime = await import("../acp/persistent-bindings.lifecycle.js");
  return runtime.ensureConfiguredAcpBindingReady(params);
}

// 重新导出 Tailnet 主机解析函数
export { resolveTailnetHostWithRunner } from "../shared/tailscale-status.js";
// 重新导出 Tailnet 状态命令类型
export type {
  TailscaleStatusCommandResult,
  TailscaleStatusCommandRunner,
} from "../shared/tailscale-status.js";
// 重新导出代理会话键构建函数
export {
  buildAgentSessionKey,
  type RoutePeer,
  type RoutePeerKind,
} from "../routing/resolve-route.js";
// 重新导出线程会话键解析函数
export { resolveThreadSessionKeys } from "../routing/session-key.js";

// ============ 渠道出站会话路由类型 ============

/**
 * 渠道出站会话路由参数类型
 */
export type ChannelOutboundSessionRouteParams = Parameters<
  NonNullable<ChannelMessagingAdapter["resolveOutboundSessionRoute"]>
>[0];

// ============ SDK 聊天渠道元数据缓存 ============

// 缓存的 SDK 聊天渠道元数据
let cachedSdkChatChannelMeta:
  | {
      cacheKey: string;
      metaById: ReturnType<typeof buildChatChannelMetaById>;
    }
  | undefined;

/**
 * 解析 SDK 聊天渠道元数据
 * 使用缓存提高性能
 * @param id - 渠道 ID
 * @returns 渠道元数据
 */
function resolveSdkChatChannelMeta(id: string) {
  const cacheKey = resolveBundledPluginsDir(process.env) ?? "";
  // 如果缓存键变化，更新缓存
  if (cachedSdkChatChannelMeta?.cacheKey !== cacheKey) {
    cachedSdkChatChannelMeta = {
      cacheKey,
      metaById: buildChatChannelMetaById(),
    };
  }
  return cachedSdkChatChannelMeta.metaById[id];
}

/**
 * 获取聊天渠道元数据
 * @param id - 聊天渠道 ID
 * @returns 渠道元数据
 */
export function getChatChannelMeta(id: ChatChannelId): ChannelMeta {
  return resolveSdkChatChannelMeta(id);
}

// ============ 字符串处理函数 ============

/**
 * 从自由格式目标字符串中移除已知提供商前缀
 * @param raw - 原始字符串
 * @param providers - 提供商列表
 * @returns 移除前缀后的字符串
 */
export function stripChannelTargetPrefix(raw: string, ...providers: string[]): string {
  const trimmed = raw.trim();
  for (const provider of providers) {
    const prefix = `${normalizeLowercaseStringOrEmpty(provider)}:`;
    if (normalizeLowercaseStringOrEmpty(trimmed).startsWith(prefix)) {
      return trimmed.slice(prefix.length).trim();
    }
  }
  return trimmed;
}

/**
 * 移除通用目标类型前缀（如 user:、group:）
 * @param raw - 原始字符串
 * @returns 移除前缀后的字符串
 */
export function stripTargetKindPrefix(raw: string): string {
  return raw.replace(/^(user|channel|group|conversation|room|dm):/i, "").trim();
}

// ============ 渠道出站会话路由构建函数 ============

/**
 * 构建渠道出站会话路由
 * 这是渠道消息适配器返回的规范出站会话路由载荷
 * @param params - 包含配置、代理 ID、渠道等信息的对象
 * @returns 渠道出站会话路由
 */
export function buildChannelOutboundSessionRoute(params: {
  cfg: OpenClawConfig;
  agentId: string;
  channel: string;
  accountId?: string | null;
  peer: { kind: "direct" | "group" | "channel"; id: string };
  chatType: "direct" | "group" | "channel";
  from: string;
  to: string;
  threadId?: string | number;
}): ChannelOutboundSessionRoute {
  const baseSessionKey = buildOutboundBaseSessionKey({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: params.channel,
    accountId: params.accountId,
    peer: params.peer,
  });
  return {
    sessionKey: baseSessionKey,
    baseSessionKey,
    peer: params.peer,
    chatType: params.chatType,
    from: params.from,
    to: params.to,
    // 如果有线程 ID，添加它
    ...(params.threadId !== undefined ? { threadId: params.threadId } : {}),
  };
}

// ============ 线程感知出站会话路由类型 ============

/**
 * 线程感知出站会话路由线程来源
 */
export type ThreadAwareOutboundSessionRouteThreadSource =
  | "replyToId"
  | "threadId"
  | "currentSession";

/**
 * 线程感知出站会话路由恢复上下文
 */
export type ThreadAwareOutboundSessionRouteRecoveryContext = {
  route: ChannelOutboundSessionRoute;
  currentBaseSessionKey: string;
  currentThreadId: string;
};

/**
 * 恢复当前线程会话 ID
 * @param params - 包含路由、当前会话键和可选恢复判断函数的对象
 * @returns 线程 ID 或 undefined
 */
export function recoverCurrentThreadSessionId(params: {
  route: ChannelOutboundSessionRoute;
  currentSessionKey?: string | null;
  canRecover?: (context: ThreadAwareOutboundSessionRouteRecoveryContext) => boolean;
}): string | undefined {
  const current = parseThreadSessionSuffix(params.currentSessionKey);
  // 如果没有基础会话键或线程 ID，返回 undefined
  if (!current.baseSessionKey || !current.threadId) {
    return undefined;
  }
  // 检查基础会话键是否匹配
  if (
    normalizeOptionalLowercaseString(current.baseSessionKey) !==
    normalizeOptionalLowercaseString(params.route.baseSessionKey)
  ) {
    return undefined;
  }
  const context = {
    route: params.route,
    currentBaseSessionKey: current.baseSessionKey,
    currentThreadId: current.threadId,
  };
  // 如果有恢复判断函数且返回 false，返回 undefined
  if (params.canRecover && !params.canRecover(context)) {
    return undefined;
  }
  return current.threadId;
}

/**
 * 构建线程感知出站会话路由
 * @param params - 包含路由、回复 ID、线程 ID 等的对象
 * @returns 线程感知的渠道出站会话路由
 */
export function buildThreadAwareOutboundSessionRoute(params: {
  route: ChannelOutboundSessionRoute;
  replyToId?: string | number | null;
  threadId?: string | number | null;
  currentSessionKey?: string | null;
  precedence?: readonly ThreadAwareOutboundSessionRouteThreadSource[];
  useSuffix?: boolean;
  parentSessionKey?: string;
  normalizeThreadId?: (threadId: string) => string;
  canRecoverCurrentThread?: (context: ThreadAwareOutboundSessionRouteRecoveryContext) => boolean;
}): ChannelOutboundSessionRoute {
  // 尝试恢复当前线程 ID
  const recoveredThreadId = recoverCurrentThreadSessionId({
    route: params.route,
    currentSessionKey: params.currentSessionKey,
    canRecover: params.canRecoverCurrentThread,
  });
  // 构建候选映射
  const candidates: Record<
    ThreadAwareOutboundSessionRouteThreadSource,
    { routeThreadId: string | number; sessionThreadId: string } | undefined
  > = {
    replyToId: resolveThreadAwareOutboundCandidate(params.replyToId),
    threadId: resolveThreadAwareOutboundCandidate(params.threadId),
    currentSession: resolveThreadAwareOutboundCandidate(recoveredThreadId),
  };
  // 根据优先级选择候选
  const precedence = params.precedence ?? ["replyToId", "threadId", "currentSession"];
  const candidate = precedence.map((source) => candidates[source]).find(Boolean);
  // 解析线程会话键
  const threadKeys = resolveThreadSessionKeys({
    baseSessionKey: params.route.baseSessionKey,
    threadId: candidate?.sessionThreadId,
    parentSessionKey: candidate ? params.parentSessionKey : undefined,
    useSuffix: params.useSuffix,
    normalizeThreadId: params.normalizeThreadId,
  });
  return {
    ...params.route,
    sessionKey: threadKeys.sessionKey,
    // 如果有候选，添加线程 ID
    ...(candidate !== undefined ? { threadId: candidate.routeThreadId } : {}),
  };
}

/**
 * 解析线程感知出站候选
 * @param threadId - 线程 ID
 * @returns 候选对象或 undefined
 */
function resolveThreadAwareOutboundCandidate(
  threadId?: string | number | null,
): { routeThreadId: string | number; sessionThreadId: string } | undefined {
  const sessionThreadId = normalizeOutboundThreadId(threadId);
  if (sessionThreadId === undefined) {
    return undefined;
  }
  return {
    routeThreadId: typeof threadId === "number" ? threadId : sessionThreadId,
    sessionThreadId,
  };
}

// ============ 渠道插件入口类型 ============

/**
 * 渠道插件入口配置 schema 类型
 */
type ChannelEntryConfigSchema<TPlugin> =
  TPlugin extends ChannelPlugin<unknown>
    ? NonNullable<TPlugin["configSchema"]>
    : ChannelConfigSchema;

/**
 * 定义渠道插件入口选项
 */
type DefineChannelPluginEntryOptions<TPlugin = ChannelPlugin> = {
  id: string;
  name: string;
  description: string;
  plugin: TPlugin;
  configSchema?: ChannelEntryConfigSchema<TPlugin> | (() => ChannelEntryConfigSchema<TPlugin>);
  setRuntime?: (runtime: PluginRuntime) => void;
  registerCliMetadata?: (api: OpenClawPluginApi) => void;
  registerFull?: (api: OpenClawPluginApi) => void;
};

/**
 * 已定义的渠道插件入口
 */
type DefinedChannelPluginEntry<TPlugin> = {
  id: string;
  name: string;
  description: string;
  configSchema: ChannelEntryConfigSchema<TPlugin>;
  register: (api: OpenClawPluginApi) => void;
  channelPlugin: TPlugin;
  setChannelRuntime?: (runtime: PluginRuntime) => void;
};

// ============ 聊天渠道插件构建类型 ============

/**
 * 聊天渠道插件基础类型
 */
type ChatChannelPluginBase<TResolvedAccount, Probe, Audit> = Omit<
  ChannelPlugin<TResolvedAccount, Probe, Audit>,
  "security" | "pairing" | "threading" | "outbound"
> &
  Partial<
    Pick<
      ChannelPlugin<TResolvedAccount, Probe, Audit>,
      "security" | "pairing" | "threading" | "outbound"
    >
  >;

/**
 * 聊天渠道安全选项
 */
type ChatChannelSecurityOptions<TResolvedAccount extends { accountId?: string | null }> = {
  dm: {
    channelKey: string;
    resolvePolicy: (account: TResolvedAccount) => string | null | undefined;
    resolveAllowFrom: (account: TResolvedAccount) => Array<string | number> | null | undefined;
    resolveFallbackAccountId?: (account: TResolvedAccount) => string | null | undefined;
    defaultPolicy?: string;
    allowFromPathSuffix?: string;
    policyPathSuffix?: string;
    approveChannelId?: string;
    approveHint?: string;
    normalizeEntry?: (raw: string) => string;
    inheritSharedDefaultsFromDefaultAccount?: boolean;
  };
  collectWarnings?: ChannelSecurityAdapter<TResolvedAccount>["collectWarnings"];
  collectAuditFindings?: ChannelSecurityAdapter<TResolvedAccount>["collectAuditFindings"];
};

/**
 * 聊天渠道配对选项
 */
type ChatChannelPairingOptions = {
  text: {
    idLabel: string;
    message: string;
    normalizeAllowEntry?: ChannelPairingAdapter["normalizeAllowEntry"];
    notify: (
      params: Parameters<NonNullable<ChannelPairingAdapter["notifyApproval"]>>[0] & {
        message: string;
      },
    ) => Promise<void> | void;
  };
};

/**
 * 聊天渠道线程回复模式选项
 */
type ChatChannelThreadingReplyModeOptions<TResolvedAccount> =
  | { topLevelReplyToMode: string }
  | {
      scopedAccountReplyToMode: {
        resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) => TResolvedAccount;
        resolveReplyToMode: (
          account: TResolvedAccount,
          chatType?: string | null,
        ) => ReplyToMode | null | undefined;
        fallback?: ReplyToMode;
      };
    }
  | {
      resolveReplyToMode: NonNullable<ChannelThreadingAdapter["resolveReplyToMode"]>;
    };

/**
 * 聊天渠道线程选项
 */
type ChatChannelThreadingOptions<TResolvedAccount> =
  ChatChannelThreadingReplyModeOptions<TResolvedAccount> &
    Omit<ChannelThreadingAdapter, "resolveReplyToMode">;

/**
 * 聊天渠道附加出站选项
 */
type ChatChannelAttachedOutboundOptions = {
  base: Omit<ChannelOutboundAdapter, "sendText" | "sendMedia" | "sendPoll">;
  attachedResults: {
    channel: string;
    sendText?: (
      ctx: Parameters<NonNullable<ChannelOutboundAdapter["sendText"]>>[0],
    ) => MaybePromise<Omit<OutboundDeliveryResult, "channel">>;
    sendMedia?: (
      ctx: Parameters<NonNullable<ChannelOutboundAdapter["sendMedia"]>>[0],
    ) => MaybePromise<Omit<OutboundDeliveryResult, "channel">>;
    sendPoll?: (
      ctx: Parameters<NonNullable<ChannelOutboundAdapter["sendPoll"]>>[0],
    ) => MaybePromise<Omit<ChannelPollResult, "channel">>;
  };
};

/**
 * 可能为 Promise 的类型
 */
type MaybePromise<T> = T | Promise<T>;

// ============ 内部辅助函数 ============

/**
 * 创建内联附加渠道结果适配器
 * @param params - 附加结果配置
 * @returns 渠道出站适配器
 */
function createInlineAttachedChannelResultAdapter(
  params: ChatChannelAttachedOutboundOptions["attachedResults"],
) {
  return {
    sendText: params.sendText
      ? async (ctx: Parameters<NonNullable<ChannelOutboundAdapter["sendText"]>>[0]) => ({
          channel: params.channel,
          ...(await params.sendText!(ctx)),
        })
      : undefined,
    sendMedia: params.sendMedia
      ? async (ctx: Parameters<NonNullable<ChannelOutboundAdapter["sendMedia"]>>[0]) => ({
          channel: params.channel,
          ...(await params.sendMedia!(ctx)),
        })
      : undefined,
    sendPoll: params.sendPoll
      ? async (ctx: Parameters<NonNullable<ChannelOutboundAdapter["sendPoll"]>>[0]) => ({
          channel: params.channel,
          ...(await params.sendPoll!(ctx)),
        })
      : undefined,
  } satisfies Pick<ChannelOutboundAdapter, "sendText" | "sendMedia" | "sendPoll">;
}

/**
 * 解析聊天渠道安全配置
 * @param security - 安全配置
 * @returns 解析后的安全适配器
 */
function resolveChatChannelSecurity<TResolvedAccount extends { accountId?: string | null }>(
  security:
    | ChannelSecurityAdapter<TResolvedAccount>
    | ChatChannelSecurityOptions<TResolvedAccount>
    | undefined,
): ChannelSecurityAdapter<TResolvedAccount> | undefined {
  if (!security) {
    return undefined;
  }
  if (!("dm" in security)) {
    return security;
  }
  return {
    resolveDmPolicy: ({ cfg, accountId, account }) =>
      buildAccountScopedDmSecurityPolicy({
        cfg,
        channelKey: security.dm.channelKey,
        accountId,
        fallbackAccountId: security.dm.resolveFallbackAccountId?.(account) ?? account.accountId,
        policy: security.dm.resolvePolicy(account),
        allowFrom: security.dm.resolveAllowFrom(account) ?? [],
        defaultPolicy: security.dm.defaultPolicy,
        allowFromPathSuffix: security.dm.allowFromPathSuffix,
        policyPathSuffix: security.dm.policyPathSuffix,
        approveChannelId: security.dm.approveChannelId,
        approveHint: security.dm.approveHint,
        normalizeEntry: security.dm.normalizeEntry,
        inheritSharedDefaultsFromDefaultAccount:
          security.dm.inheritSharedDefaultsFromDefaultAccount,
      }),
    // 如果有警告收集器，添加它
    ...(security.collectWarnings ? { collectWarnings: security.collectWarnings } : {}),
    // 如果有审计发现收集器，添加它
    ...(security.collectAuditFindings
      ? { collectAuditFindings: security.collectAuditFindings }
      : {}),
  };
}

/**
 * 解析聊天渠道配对配置
 * @param pairing - 配对配置
 * @returns 解析后的配对适配器
 */
function resolveChatChannelPairing(
  pairing: ChannelPairingAdapter | ChatChannelPairingOptions | undefined,
): ChannelPairingAdapter | undefined {
  if (!pairing) {
    return undefined;
  }
  if (!("text" in pairing)) {
    return pairing;
  }
  return createInlineTextPairingAdapter(pairing.text);
}

/**
 * 解析聊天渠道线程配置
 * @param threading - 线程配置
 * @returns 解析后的线程适配器
 */
function resolveChatChannelThreading<TResolvedAccount>(
  threading: ChannelThreadingAdapter | ChatChannelThreadingOptions<TResolvedAccount> | undefined,
): ChannelThreadingAdapter | undefined {
  if (!threading) {
    return undefined;
  }
  // 如果不是高级配置格式，直接返回
  if (!("topLevelReplyToMode" in threading) && !("scopedAccountReplyToMode" in threading)) {
    return threading;
  }

  let resolveReplyToMode: ChannelThreadingAdapter["resolveReplyToMode"];
  if ("topLevelReplyToMode" in threading) {
    resolveReplyToMode = createTopLevelChannelReplyToModeResolver(threading.topLevelReplyToMode);
  } else {
    resolveReplyToMode = createScopedAccountReplyToModeResolver<TResolvedAccount>(
      threading.scopedAccountReplyToMode,
    );
  }

  return {
    ...threading,
    resolveReplyToMode,
  };
}

/**
 * 解析聊天渠道出站配置
 * @param outbound - 出站配置
 * @returns 解析后的出站适配器
 */
function resolveChatChannelOutbound(
  outbound: ChannelOutboundAdapter | ChatChannelAttachedOutboundOptions | undefined,
): ChannelOutboundAdapter | undefined {
  if (!outbound) {
    return undefined;
  }
  if (!("attachedResults" in outbound)) {
    return outbound;
  }
  return {
    ...outbound.base,
    ...createInlineAttachedChannelResultAdapter(outbound.attachedResults),
  };
}

// ============ 渠道插件构建器函数 ============

/**
 * 创建聊天渠道插件
 * 
 * 这是一个共享的高级构建器，用于创建聊天风格的渠道插件，
 * 主要组合了作用域 DM 安全、文本配对、回复线程和附加发送结果。
 * 
 * @param params - 包含 base、security、pairing、threading、outbound 的对象
 * @returns 渠道插件
 */
export function createChatChannelPlugin<
  TResolvedAccount extends { accountId?: string | null },
  Probe = unknown,
  Audit = unknown,
>(params: {
  base: ChatChannelPluginBase<TResolvedAccount, Probe, Audit>;
  security?:
    | ChannelSecurityAdapter<TResolvedAccount>
    | ChatChannelSecurityOptions<TResolvedAccount>;
  pairing?: ChannelPairingAdapter | ChatChannelPairingOptions;
  threading?: ChannelThreadingAdapter | ChatChannelThreadingOptions<TResolvedAccount>;
  outbound?: ChannelOutboundAdapter | ChatChannelAttachedOutboundOptions;
}): ChannelPlugin<TResolvedAccount, Probe, Audit> {
  return {
    ...params.base,
    conversationBindings: {
      supportsCurrentConversationBinding: true,
      ...params.base.conversationBindings,
    },
    // 如果有安全配置，添加解析后的安全配置
    ...(params.security ? { security: resolveChatChannelSecurity(params.security) } : {}),
    // 如果有配对配置，添加解析后的配对配置
    ...(params.pairing ? { pairing: resolveChatChannelPairing(params.pairing) } : {}),
    // 如果有线程配置，添加解析后的线程配置
    ...(params.threading ? { threading: resolveChatChannelThreading(params.threading) } : {}),
    // 如果有出站配置，添加解析后的出站配置
    ...(params.outbound ? { outbound: resolveChatChannelOutbound(params.outbound) } : {}),
  } as ChannelPlugin<TResolvedAccount, Probe, Audit>;
}

/**
 * 创建渠道插件基础对象
 * 
 * 共享的基础对象，用于只需要覆盖少数可选功能的渠道插件。
 * 
 * @param params - 创建基础对象的参数
 * @returns 渠道插件基础对象
 */
export function createChannelPluginBase<TResolvedAccount>(
  params: CreateChannelPluginBaseOptions<TResolvedAccount>,
): CreatedChannelPluginBase<TResolvedAccount> {
  return {
    id: params.id,
    meta: {
      ...resolveSdkChatChannelMeta(params.id),
      ...params.meta,
    },
    // 如果有设置向导，添加
    ...(params.setupWizard ? { setupWizard: params.setupWizard } : {}),
    // 如果有能力，添加
    ...(params.capabilities ? { capabilities: params.capabilities } : {}),
    // 如果有命令，添加
    ...(params.commands ? { commands: params.commands } : {}),
    // 如果有医生检查，添加
    ...(params.doctor ? { doctor: params.doctor } : {}),
    // 如果有代理提示，添加
    ...(params.agentPrompt ? { agentPrompt: params.agentPrompt } : {}),
    // 如果有流式处理，添加
    ...(params.streaming ? { streaming: params.streaming } : {}),
    // 如果有重载处理，添加
    ...(params.reload ? { reload: params.reload } : {}),
    // 如果有网关方法，添加
    ...(params.gatewayMethods ? { gatewayMethods: params.gatewayMethods } : {}),
    // 如果有配置 schema，添加
    ...(params.configSchema ? { configSchema: params.configSchema } : {}),
    // 如果有配置，添加
    ...(params.config ? { config: params.config } : {}),
    // 如果有安全配置，添加
    ...(params.security ? { security: params.security } : {}),
    // 如果有组，添加
    ...(params.groups ? { groups: params.groups } : {}),
    setup: params.setup,
  } as CreatedChannelPluginBase<TResolvedAccount>;
}
