/**
 * Stable public facade for native plugin contracts.
 *
 * Domain types live in leaf modules so internal owners can depend on narrow
 * surfaces without loading or navigating the complete plugin API contract.
 */
export type { AgentHarness } from "../agents/harness/types.js";
export type { AnyAgentTool } from "../agents/tools/common.js";
export type {
  CliBackendAuthEpochMode,
  CliBackendExecutionMode,
  CliBackendNormalizeConfigContext,
  CliBackendNativeToolMode,
  CliBackendPlugin,
  CliBackendPreparedExecution,
  CliBackendPrepareExecutionContext,
  CliBackendResolveExecutionArgs,
  CliBackendResolveExecutionArgsContext,
  CliBackendSideQuestionToolMode,
  CliBackendThinkingLevel,
  CliBundleMcpMode,
  PluginTextTransforms,
} from "./cli-backend.types.js";
export type {
  PluginConversationBinding,
  PluginConversationBindingRequestParams,
  PluginConversationBindingRequestResult,
  PluginConversationBindingResolvedEvent,
} from "./conversation-binding.types.js";
export * from "./hook-types.js";
export type {
  PluginAgentEventEmitParams,
  PluginAgentEventEmitResult,
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
  PluginSessionActionContext,
  PluginSessionActionRegistration,
  PluginSessionActionResult,
  PluginSessionAttachmentParams,
  PluginSessionAttachmentResult,
  PluginSessionExtensionProjection,
  PluginSessionExtensionRegistration,
  PluginSessionSchedulerJobHandle,
  PluginSessionSchedulerJobRegistration,
  PluginSessionTurnScheduleParams,
  PluginSessionTurnUnscheduleByTagParams,
  PluginSessionTurnUnscheduleByTagResult,
  PluginToolMetadataRegistration,
  PluginTrustedToolPolicyRegistration,
} from "./host-hooks.js";
export type { PluginLogger } from "./logger-types.js";
export type { PluginConfigUiHint } from "./manifest-types.js";
export type { PluginOrigin } from "./plugin-origin.types.js";
export type {
  ProviderApplyConfigDefaultsContext,
  ProviderNormalizeConfigContext,
  ProviderResolveConfigApiKeyContext,
} from "./provider-config-context.types.js";
export type {
  ProviderAuthOptionBag,
  ProviderExternalAuthProfile,
  ProviderResolveExternalAuthProfilesContext,
  ProviderResolveSyntheticAuthContext,
} from "./provider-external-auth.types.js";
export type { ProviderRuntimeModel } from "./provider-runtime-model.types.js";
export type {
  ProviderDefaultThinkingPolicyContext,
  ProviderThinkingPolicyContext,
  ProviderThinkingProfile,
} from "./provider-thinking.types.js";
export type {
  OpenClawPluginActiveModelContext,
  OpenClawPluginHookOptions,
  OpenClawPluginToolContext,
  OpenClawPluginToolFactory,
  OpenClawPluginToolOptions,
} from "./tool-types.js";
export type {
  OpenClawPluginNodeHostCommand,
  OpenClawPluginNodeHostCommandAvailabilityContext,
  OpenClawPluginNodeHostCommandIo,
} from "./types.node-host.js";
export type {
  PluginWebFetchProviderEntry,
  PluginWebSearchProviderEntry,
  WebFetchCredentialResolutionSource,
  WebFetchProviderPlugin,
  WebFetchProviderToolDefinition,
  WebSearchCredentialResolutionSource,
  WebSearchProviderPlugin,
  WebSearchProviderSetupContext,
  WebSearchProviderToolDefinition,
  WebSearchProviderToolExecutionContext,
} from "./web-provider-types.js";
export type * from "./types.mcp-connection.js";

export { WorkerProviderError } from "./capability-provider.types.js";
export type * from "./capability-provider.types.js";
export type * from "./migration-provider.types.js";
export type * from "./plugin-api.types.js";
export { AGENT_PROMPT_SURFACE_KINDS } from "./plugin-command.types.js";
export type * from "./plugin-command.types.js";
export type * from "./plugin-config-schema.types.js";
export type * from "./plugin-definition.types.js";
export type * from "./plugin-registration.types.js";
export type * from "./provider-authentication.types.js";
export type * from "./provider-catalog.types.js";
export type * from "./provider-plugin.types.js";
export type * from "./provider-replay.types.js";
export type * from "./provider-runtime.types.js";
export type * from "./provider-transport.types.js";
