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
export type { ChannelConfigSchema, ChannelPlugin } from "../channels/plugins/types.plugin.js";
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
  MediaUnderstandingProviderPlugin,
  OpenClawPluginApi,
  OpenClawPluginConfigSchema,
  PluginLogger,
  ProviderAuthContext,
  ProviderAuthResult,
  ProviderRuntimeModel,
  SpeechProviderPlugin,
} from "../plugins/types.js";
export type {
  PluginRuntime,
  RuntimeLogger,
  SubagentRunParams,
  SubagentRunResult,
} from "../plugins/runtime/types.js";
export type { OpenClawConfig } from "../config/config.js";
/** @deprecated Use OpenClawConfig instead */
export type { OpenClawConfig as ClawdbotConfig } from "../config/config.js";
export * from "./image-generation.js";
export type { SecretInput, SecretRef } from "../config/types.secrets.js";
export type { RuntimeEnv } from "../runtime.js";
export type { HookEntry } from "../hooks/types.js";
export type { ReplyPayload } from "../auto-reply/types.js";
export type { WizardPrompter } from "../wizard/prompts.js";
export type { ContextEngineFactory } from "../context-engine/registry.js";
export type { DiagnosticEventPayload } from "../infra/diagnostic-events.js";
export type {
  ContextEngine,
  ContextEngineInfo,
  ContextEngineMaintenanceResult,
  ContextEngineRuntimeContext,
  TranscriptRewriteReplacement,
  TranscriptRewriteRequest,
  TranscriptRewriteResult,
} from "../context-engine/types.js";

export { onDiagnosticEvent } from "../infra/diagnostic-events.js";
export { emptyPluginConfigSchema } from "../plugins/config-schema.js";
export { registerContextEngine } from "../context-engine/registry.js";
export { delegateCompactionToRuntime } from "../context-engine/delegate.js";
// Model authentication types for plugins.
// Plugins should use runtime.modelAuth (which strips unsafe overrides like
// agentDir/store) rather than importing raw helpers directly.
export { requireApiKey } from "../agents/model-auth.js";
export type { ResolvedProviderAuth } from "../agents/model-auth.js";
export type {
  ProviderCatalogContext,
  ProviderCatalogResult,
  ProviderDiscoveryContext,
} from "../plugins/types.js";
export {
  applyProviderDefaultModel,
  promptAndConfigureOpenAICompatibleSelfHostedProvider,
  SELF_HOSTED_DEFAULT_CONTEXT_WINDOW,
  SELF_HOSTED_DEFAULT_COST,
  SELF_HOSTED_DEFAULT_MAX_TOKENS,
} from "../commands/self-hosted-provider-setup.js";
export {
  OLLAMA_DEFAULT_BASE_URL,
  OLLAMA_DEFAULT_MODEL,
  configureOllamaNonInteractive,
  ensureOllamaModelPulled,
  promptAndConfigureOllama,
} from "../commands/ollama-setup.js";
export {
  VLLM_DEFAULT_BASE_URL,
  VLLM_DEFAULT_CONTEXT_WINDOW,
  VLLM_DEFAULT_COST,
  VLLM_DEFAULT_MAX_TOKENS,
  promptAndConfigureVllm,
} from "../commands/vllm-setup.js";
export {
  buildOllamaProvider,
  buildSglangProvider,
  buildVllmProvider,
} from "../agents/models-config.providers.discovery.js";

// Security utilities
export { redactSensitiveText } from "../logging/redact.js";

// Media provider plugin types
export type {
  AudioTranscriptionRequest,
  AudioTranscriptionResult,
  VideoDescriptionRequest,
  VideoDescriptionResult,
  ImageDescriptionRequest,
  ImageDescriptionResult,
  TextToSpeechRequest,
  TextToSpeechResult,
  PluginImageDescriptionRequest,
  PluginAudioTranscriptionRequest,
  PluginVideoDescriptionRequest,
  PluginTextToSpeechRequest,
} from "../plugins/types.js";

// Provider capability and embedding types
export type {
  ProviderCapability,
  ProviderEmbedRequest,
  ProviderEmbedResult,
  ProviderEmbedBatchRequest,
  ProviderEmbedBatchResult,
} from "../plugins/types.js";
