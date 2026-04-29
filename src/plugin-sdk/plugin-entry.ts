/**
 * 插件入口模块
 * 
 * 本模块定义了插件的基本入口结构和类型，是 OpenClaw 插件系统的核心部分。
 * 插件是扩展 OpenClaw 功能的模块，可以注册 providers、tools、commands、services 等。
 */

// 导入配置类型
import type { OpenClawConfig } from "../config/types.openclaw.js";
// 导入空插件配置 schema
import { emptyPluginConfigSchema } from "../plugins/config-schema.js";
// 导入运行时 Provider 模型类型
import type { ProviderRuntimeModel } from "../plugins/provider-runtime-model.types.js";
// 导入插件相关的类型定义
import type {
  AnyAgentTool,
  AgentHarness,
  MediaUnderstandingProviderPlugin,
  MigrationApplyResult,
  MigrationDetection,
  MigrationItem,
  MigrationPlan,
  MigrationProviderContext,
  MigrationProviderPlugin,
  MigrationSummary,
  OpenClawPluginApi,
  OpenClawPluginCommandDefinition,
  OpenClawPluginConfigSchema,
  OpenClawPluginDefinition,
  OpenClawPluginHttpRouteHandler,
  OpenClawPluginNodeHostCommand,
  OpenClawPluginReloadRegistration,
  OpenClawPluginSecurityAuditCollector,
  OpenClawPluginSecurityAuditContext,
  OpenClawPluginService,
  OpenClawPluginServiceContext,
  OpenClawPluginToolContext,
  OpenClawPluginToolFactory,
  PluginLogger,
  ProviderAugmentModelCatalogContext,
  ProviderAuthContext,
  ProviderAuthDoctorHintContext,
  ProviderAuthMethod,
  ProviderAuthMethodNonInteractiveContext,
  ProviderAuthResult,
  ProviderApplyConfigDefaultsContext,
  ProviderBuildMissingAuthMessageContext,
  ProviderBuildUnknownModelHintContext,
  ProviderBuiltInModelSuppressionContext,
  ProviderBuiltInModelSuppressionResult,
  ProviderCacheTtlEligibilityContext,
  ProviderCatalogContext,
  ProviderCatalogResult,
  ProviderDeferSyntheticProfileAuthContext,
  ProviderDefaultThinkingPolicyContext,
  ProviderDiscoveryContext,
  ProviderFailoverErrorContext,
  ProviderFetchUsageSnapshotContext,
  ProviderModernModelPolicyContext,
  ProviderNormalizeConfigContext,
  ProviderNormalizeToolSchemasContext,
  ProviderNormalizeTransportContext,
  ProviderResolveConfigApiKeyContext,
  ProviderNormalizeModelIdContext,
  ProviderNormalizeResolvedModelContext,
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
  RealtimeTranscriptionProviderPlugin,
  ProviderResolvedUsageAuth,
  ProviderResolveDynamicModelContext,
  ProviderResolveTransportTurnStateContext,
  ProviderResolveWebSocketSessionPolicyContext,
  ProviderSanitizeReplayHistoryContext,
  ProviderTransportTurnState,
  ProviderToolSchemaDiagnostic,
  ProviderResolveUsageAuthContext,
  ProviderThinkingProfile,
  ProviderThinkingPolicyContext,
  ProviderValidateReplayTurnsContext,
  ProviderWebSocketSessionPolicy,
  ProviderWrapStreamFnContext,
  OpenClawGatewayDiscoveryAdvertiseContext,
  OpenClawGatewayDiscoveryService,
  SpeechProviderPlugin,
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
} from "../plugins/types.js";
// 导入延迟值获取器
import { createCachedLazyValueGetter } from "./lazy-value.js";

// ============ 类型导出 ============

// 导出代理工具相关类型
export type {
  AnyAgentTool,
  AgentHarness,
  MediaUnderstandingProviderPlugin,
};
// 导出迁移相关类型
export type {
  MigrationApplyResult,
  MigrationDetection,
  MigrationItem,
  MigrationPlan,
  MigrationProviderContext,
  MigrationProviderPlugin,
  MigrationSummary,
};
// 导出插件 API 相关类型
export type {
  OpenClawPluginApi,
  OpenClawPluginNodeHostCommand,
  OpenClawPluginReloadRegistration,
  OpenClawPluginSecurityAuditCollector,
  OpenClawPluginSecurityAuditContext,
  OpenClawPluginToolContext,
  OpenClawPluginToolFactory,
};
// 导出命令相关类型
export type {
  PluginCommandContext,
  PluginCommandResult,
};
// 导出 Agent 事件订阅类型
export type {
  PluginAgentEventSubscriptionRegistration,
  PluginAgentTurnPrepareEvent,
  PluginAgentTurnPrepareResult,
};
// 导出控制 UI 描述符类型
export type {
  PluginControlUiDescriptor,
};
// 导出心跳提示贡献类型
export type {
  PluginHeartbeatPromptContributionEvent,
  PluginHeartbeatPromptContributionResult,
};
// 导出 JSON 值类型
export type {
  PluginJsonValue,
};
// 导出下一轮注入类型
export type {
  PluginNextTurnInjection,
  PluginNextTurnInjectionEnqueueResult,
  PluginNextTurnInjectionRecord,
};
// 导出运行上下文参数类型
export type {
  PluginRunContextGetParams,
  PluginRunContextPatch,
};
// 导出运行时生命周期注册类型
export type {
  PluginRuntimeLifecycleRegistration,
};
// 导出会话调度程序句柄和注册类型
export type {
  PluginSessionSchedulerJobHandle,
  PluginSessionSchedulerJobRegistration,
};
// 导出会话扩展注册和投影类型
export type {
  PluginSessionExtensionRegistration,
  PluginSessionExtensionProjection,
};
// 导出工具元数据和信任策略注册类型
export type {
  PluginToolMetadataRegistration,
  PluginTrustedToolPolicyRegistration,
};
// 导出配置 schema 和 HTTP 路由处理器类型
export type {
  OpenClawPluginConfigSchema,
  OpenClawPluginHttpRouteHandler,
};
// 导出 Provider 发现上下文和目录结果类型
export type {
  ProviderDiscoveryContext,
  ProviderCatalogContext,
  ProviderCatalogResult,
};
// 导出延迟合成 profile 认证上下文
export type {
  ProviderDeferSyntheticProfileAuthContext,
};
// 导出模型目录增强上下文
export type {
  ProviderAugmentModelCatalogContext,
};
// 导出配置应用默认值上下文
export type {
  ProviderApplyConfigDefaultsContext,
};
// 导出内置模型抑制上下文和结果
export type {
  ProviderBuiltInModelSuppressionContext,
  ProviderBuiltInModelSuppressionResult,
};
// 导出缺失认证消息构建上下文
export type {
  ProviderBuildMissingAuthMessageContext,
};
// 导出未知模型提示构建上下文
export type {
  ProviderBuildUnknownModelHintContext,
};
// 导出缓存 TTL 资格上下文
export type {
  ProviderCacheTtlEligibilityContext,
};
// 导出默认思考策略上下文
export type {
  ProviderDefaultThinkingPolicyContext,
};
// 导出使用量快照获取上下文
export type {
  ProviderFetchUsageSnapshotContext,
};
// 导出故障转移错误上下文
export type {
  ProviderFailoverErrorContext,
};
// 导出现代模型策略上下文
export type {
  ProviderModernModelPolicyContext,
};
// 导出配置规范化上下文
export type {
  ProviderNormalizeConfigContext,
};
// 导出工具 schema 规范化上下文
export type {
  ProviderNormalizeToolSchemasContext,
};
// 导出传输规范化上下文
export type {
  ProviderNormalizeTransportContext,
};
// 导出 API 密钥配置解析上下文
export type {
  ProviderResolveConfigApiKeyContext,
};
// 导出模型 ID 规范化上下文
export type {
  ProviderNormalizeModelIdContext,
};
// 导出重放策略相关类型
export type {
  ProviderReplayPolicy,
  ProviderReplayPolicyContext,
  ProviderReplaySessionEntry,
  ProviderReplaySessionState,
};
// 导出准备好的运行时认证
export type {
  ProviderPreparedRuntimeAuth,
};
// 导出推理输出模式类型
export type {
  ProviderReasoningOutputMode,
  ProviderReasoningOutputModeContext,
};
// 导出现已解析的使用量认证
export type {
  ProviderResolvedUsageAuth,
};
// 导出工具 schema 诊断类型
export type {
  ProviderToolSchemaDiagnostic,
};
// 导出额外参数准备上下文
export type {
  ProviderPrepareExtraParamsContext,
};
// 导出动态模型准备上下文
export type {
  ProviderPrepareDynamicModelContext,
};
// 导出运行时认证准备上下文
export type {
  ProviderPrepareRuntimeAuthContext,
};
// 导出重放历史清理上下文
export type {
  ProviderSanitizeReplayHistoryContext,
};
// 导出使用量认证解析上下文
export type {
  ProviderResolveUsageAuthContext,
};
// 导出思考配置和策略上下文
export type {
  ProviderThinkingProfile,
  ProviderThinkingPolicyContext,
};
// 导出动态模型解析上下文
export type {
  ProviderResolveDynamicModelContext,
};
// 导出传输轮状态解析上下文
export type {
  ProviderResolveTransportTurnStateContext,
};
// 导出 WebSocket 会话策略解析上下文
export type {
  ProviderResolveWebSocketSessionPolicyContext,
};
// 导出规范化后的解析模型上下文
export type {
  ProviderNormalizeResolvedModelContext,
};
// 导出实时转录提供者插件
export type {
  RealtimeTranscriptionProviderPlugin,
};
// 导出传输轮状态类型
export type {
  ProviderTransportTurnState,
};
// 导出语音提供者插件
export type {
  SpeechProviderPlugin,
};
// 导出验证重放轮次上下文
export type {
  ProviderValidateReplayTurnsContext,
};
// 导出 WebSocket 会话策略类型
export type {
  ProviderWebSocketSessionPolicy,
};
// 导出流包装函数上下文
export type {
  ProviderWrapStreamFnContext,
};
// 导出网关发现广告上下文和服务
export type {
  OpenClawGatewayDiscoveryAdvertiseContext,
  OpenClawGatewayDiscoveryService,
};
// 导出插件服务和上下文类型
export type {
  OpenClawPluginService,
  OpenClawPluginServiceContext,
};
// 导出认证相关上下文类型
export type {
  ProviderAuthContext,
  ProviderAuthDoctorHintContext,
  ProviderAuthMethodNonInteractiveContext,
  ProviderAuthMethod,
  ProviderAuthResult,
};
// 导出插件命令定义和插件定义类型
export type {
  OpenClawPluginCommandDefinition,
  OpenClawPluginDefinition,
};
// 导出日志记录器类型
export type {
  PluginLogger,
};
// 导出对话绑定相关类型
export type {
  PluginConversationBinding,
  PluginConversationBindingResolvedEvent,
  PluginConversationBindingRequestParams,
  PluginConversationBindingRequestResult,
} from "../plugins/conversation-binding.types.js";
// 导出钩子入站声明相关类型
export type {
  PluginHookInboundClaimContext,
  PluginHookInboundClaimEvent,
  PluginHookInboundClaimResult,
} from "../plugins/hook-types.js";
// 导出运行时模型类型
export type { ProviderRuntimeModel } from "../plugins/provider-runtime-model.types.js";
// 导出 OpenClaw 配置类型
export type { OpenClawConfig };

// 导出配置 schema 构建函数
export { buildPluginConfigSchema, emptyPluginConfigSchema } from "../plugins/config-schema.js";

/**
 * 插件入口选项
 * 定义创建一个插件入口所需的所有配置项
 */
type DefinePluginEntryOptions = {
  // 插件唯一标识符
  id: string;
  // 插件显示名称
  name: string;
  // 插件描述信息
  description: string;
  // 插件种类（可选）
  kind?: OpenClawPluginDefinition["kind"];
  // 配置 schema，用于验证插件配置
  configSchema?: OpenClawPluginConfigSchema | (() => OpenClawPluginConfigSchema);
  // 重载回调函数
  reload?: OpenClawPluginDefinition["reload"];
  // 节点主机命令列表
  nodeHostCommands?: OpenClawPluginDefinition["nodeHostCommands"];
  // 安全审计收集器列表
  securityAuditCollectors?: OpenClawPluginDefinition["securityAuditCollectors"];
  // 注册函数，插件的主要入口点
  register: (api: OpenClawPluginApi) => void;
};

/**
 * 定义的插件入口类型
 * 表示 OpenClaw 从插件入口模块加载的标准化对象形状
 */
type DefinedPluginEntry = {
  // 插件唯一标识符
  id: string;
  // 插件显示名称
  name: string;
  // 插件描述信息
  description: string;
  // 配置 schema
  configSchema: OpenClawPluginConfigSchema;
  // 注册函数
  register: NonNullable<OpenClawPluginDefinition["register"]>;
} & Pick<
  OpenClawPluginDefinition,
  // 可选字段：kind、reload、nodeHostCommands、securityAuditCollectors
  "kind" | "reload" | "nodeHostCommands" | "securityAuditCollectors"
>;

/**
 * 定义非通道插件的规范入口辅助函数
 * 
 * 此函数用于创建 provider、tool、command、service、memory 和 context-engine 类型的插件。
 * 通道插件应该使用 `defineChannelPluginEntry(...)`（来自 `openclaw/plugin-sdk/core`），
 * 以便继承通道能力接线。
 * 
 * @param options - 插件入口选项
 * @returns 标准化的插件入口对象，可被 OpenClaw 加载
 * 
 * @example
 * ```typescript
 * // 定义一个简单的工具插件
 * definePluginEntry({
 *   id: "my-tool-plugin",
 *   name: "My Tool Plugin",
 *   description: "A plugin that provides custom tools",
 *   register: (api) => {
 *     api.registerTool({
 *       name: "my-tool",
 *       description: "Does something useful",
 *       handler: async (ctx) => {
 *         return { result: "done" };
 *       }
 *     });
 *   }
 * });
 * ```
 */
export function definePluginEntry({
  id,
  name,
  description,
  kind,
  // 默认使用空配置 schema
  configSchema = emptyPluginConfigSchema,
  reload,
  nodeHostCommands,
  securityAuditCollectors,
  register,
}: DefinePluginEntryOptions): DefinedPluginEntry {
  // 创建配置 schema 的延迟缓存获取器
  const getConfigSchema = createCachedLazyValueGetter(configSchema);
  // 返回标准化的插件入口对象
  return {
    id,
    name,
    description,
    // 如果指定了 kind，则包含
    ...(kind ? { kind } : {}),
    // 如果指定了 reload 回调，则包含
    ...(reload ? { reload } : {}),
    // 如果指定了节点主机命令，则包含
    ...(nodeHostCommands ? { nodeHostCommands } : {}),
    // 如果指定了安全审计收集器，则包含
    ...(securityAuditCollectors ? { securityAuditCollectors } : {}),
    // 配置 schema 使用 getter 以支持延迟计算
    get configSchema() {
      return getConfigSchema();
    },
    // 注册函数
    register,
  };
}
