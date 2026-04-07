// Shared root plugin-sdk surface.
// Keep this entry intentionally tiny. Channel/provider helpers belong on
// dedicated subpaths or, for legacy consumers, the compat surface.

export type {
  ChannelAccountSnapshot,
  ChannelAgentTool,
  ChannelAgentToolFactory,
  ChannelCapabilities,
  ChannelGatewayContext,
  ChannelId,
  ChannelMessageActionAdapter,
  ChannelMessageActionContext,
  ChannelMessageActionName,
  ChannelStatusIssue,
} from "../channels/plugins/types.js";
export type {
  ChannelConfiguredBindingConversationRef,
  ChannelConfiguredBindingMatch,
  ChannelConfiguredBindingProvider,
} from "../channels/plugins/types.adapters.js";
export type {
  ChannelConfigSchema,
  ChannelConfigUiHint,
  ChannelPlugin,
} from "../channels/plugins/types.plugin.js";
export type { ChannelSetupAdapter, ChannelSetupInput } from "../channels/plugins/types.js";
export type {
  ConfiguredBindingConversation,
  ConfiguredBindingResolution,
  CompiledConfiguredBinding,
  StatefulBindingTargetDescriptor,
} from "../channels/plugins/binding-types.js";
export type {
  StatefulBindingTargetDriver,
  StatefulBindingTargetReadyResult,
  StatefulBindingTargetResetResult,
  StatefulBindingTargetSessionResult,
} from "../channels/plugins/stateful-target-drivers.js";
export type {
  ChannelSetupWizard,
  ChannelSetupWizardAllowFromEntry,
} from "../channels/plugins/setup-wizard.js";
export type {
  AnyAgentTool,
  CliBackendPlugin,
  MediaUnderstandingProviderPlugin,
  OpenClawPluginApi,
  OpenClawPluginConfigSchema,
  PluginLogger,
  ProviderAuthContext,
  ProviderAuthResult,
  ProviderRuntimeModel,
  RealtimeTranscriptionProviderPlugin,
  SpeechProviderPlugin,
} from "../plugins/types.js";
export type {
  PluginRuntime,
  RuntimeLogger,
  SubagentRunParams,
  SubagentRunResult,
} from "../plugins/runtime/types.js";
export type {
  BoundTaskFlowsRuntime,
  BoundTaskRunsRuntime,
  PluginRuntimeTaskFlows,
  PluginRuntimeTaskRuns,
  PluginRuntimeTasks,
} from "../plugins/runtime/runtime-tasks.js";
export type {
  TaskFlowDetail,
  TaskFlowView,
  TaskRunAggregateSummary,
  TaskRunCancelResult,
  TaskRunDetail,
  TaskRunView,
} from "../plugins/runtime/task-domain-types.js";
export type { OpenClawConfig } from "../config/config.js";
/** @deprecated Use OpenClawConfig instead */
export type { OpenClawConfig as ClawdbotConfig } from "../config/config.js";
export type {
  MemoryPluginCapability,
  MemoryPluginPublicArtifact,
  MemoryPluginPublicArtifactsProvider,
} from "../plugins/memory-state.js";
export type { CliBackendConfig } from "../config/types.js";
export * from "./image-generation.js";
export * from "./music-generation.js";
export type { SecretInput, SecretRef } from "../config/types.secrets.js";
export type { RuntimeEnv } from "../runtime.js";
export type { HookEntry } from "../hooks/types.js";
export type { ReplyPayload } from "../auto-reply/types.js";
export type { WizardPrompter } from "../wizard/prompts.js";
export type { ContextEngineFactory } from "../context-engine/registry.js";
export type { DiagnosticEventPayload } from "../infra/diagnostic-events.js";
export type {
  AssembleResult,
  BootstrapResult,
  CompactResult,
  ContextEngine,
  ContextEngineInfo,
  ContextEngineMaintenanceResult,
  ContextEngineRuntimeContext,
  IngestBatchResult,
  IngestResult,
  SubagentEndReason,
  SubagentSpawnPreparation,
  TranscriptRewriteReplacement,
  TranscriptRewriteRequest,
  TranscriptRewriteResult,
} from "../context-engine/types.js";

export { emptyPluginConfigSchema } from "../plugins/config-schema.js";
export { registerContextEngine } from "../context-engine/registry.js";
export { delegateCompactionToRuntime } from "../context-engine/delegate.js";
export { onDiagnosticEvent } from "../infra/diagnostic-events.js";
