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
  CliBackendResolveRuntimeToolAvailability,
  CliBackendResolveRuntimeToolAvailabilityContext,
  CliBackendRuntimeToolAvailability,
  CliBackendSideQuestionToolMode,
  CliBackendToolAvailability,
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

/**
 * Provider-owned transport normalization for arbitrary provider/model config.
 *
 * Use this when transport cleanup depends on API/baseUrl rather than the
 * owning provider id, for example custom providers that still target a
 * plugin-owned transport family.
 */
export type ProviderNormalizeTransportContext = {
  config?: OpenClawConfig;
  workspaceDir?: string;
  provider: string;
  modelId?: string;
  api?: string | null;
  baseUrl?: string;
};

/**
 * Runtime auth input for providers that need an extra exchange step before
 * inference. The incoming `apiKey` is the raw credential resolved from auth
 * profiles/env/config. The returned value should be the actual token/key to use
 * for the request.
 */
export type ProviderPrepareRuntimeAuthContext = {
  config?: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
  provider: string;
  modelId: string;
  model: ProviderRuntimeModel;
  apiKey: string;
  authMode: string;
  profileId?: string;
};

/**
 * Result of `prepareRuntimeAuth`.
 *
 * `apiKey` is required and becomes the runtime credential stored in auth
 * storage. `baseUrl` is optional and lets providers like GitHub Copilot swap to
 * an entitlement-specific endpoint at request time. `expiresAt` enables generic
 * background refresh in long-running turns.
 */
export type ProviderPreparedRuntimeAuth = {
  apiKey: string;
  baseUrl?: string;
  request?: ModelProviderRequestTransportOverrides;
  expiresAt?: number;
};

/**
 * Usage/billing auth input for providers that expose quota/usage endpoints.
 *
 * This hook is intentionally separate from `prepareRuntimeAuth`: usage
 * snapshots often need a different credential source than live inference
 * requests, and they run outside the embedded runner.
 *
 * The helper methods cover the common OpenClaw auth resolution paths:
 *
 * - `resolveApiKeyFromConfigAndStore`: env/config/plain token/api_key profiles
 * - `resolveOAuthToken`: oauth/token profiles resolved through the auth store,
 *   optionally for an explicit provider override
 *
 * Plugins can still do extra provider-specific work on top (for example parse a
 * token blob, read a legacy credential file, or pick between aliases).
 */
export type ProviderResolveUsageAuthContext = {
  config: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
  provider: string;
  resolveApiKeyFromConfigAndStore: (params?: {
    providerIds?: string[];
    envDirect?: Array<string | undefined>;
  }) => string | undefined;
  /** Ordered API-key/token candidates, including resolved SecretRefs, for credential classification. */
  resolveApiKeyCandidatesFromConfigAndStore?: (params?: {
    providerIds?: string[];
    envDirect?: Array<string | undefined>;
  }) => Promise<string[]>;
  resolveOAuthToken: (params?: { provider?: string }) => Promise<ProviderUsageAuthToken | null>;
};

export type ProviderUsageAuthToken = {
  token: string;
  accountId?: string;
  /** Non-secret plan metadata from the resolved credential (e.g. Claude "max"). */
  subscriptionType?: string;
  rateLimitTier?: string;
  /** Account email captured on the resolved credential, when known. */
  email?: string;
};

/**
 * Result of `resolveUsageAuth`.
 *
 * Two shapes are supported:
 * - `{ token: string; accountId?: string }` — use this token for provider usage endpoints.
 * - `{ handled: true }` — this provider handled the request but has no usable
 *   usage token; core must skip further fallback (generic API-key/OAuth fallback
 *   must not run).
 *
 * Returning `null` or `undefined` means "not handled by this provider"; core
 * proceeds to generic fallback resolution.
 */
export type ProviderResolvedUsageAuth = ProviderUsageAuthToken | { handled: true };

/**
 * Usage/quota snapshot input for providers that own their usage endpoint
 * fetch/parsing behavior.
 *
 * This hook runs after `resolveUsageAuth` succeeds. Core still owns summary
 * fan-out, timeout wrapping, filtering, and formatting; the provider plugin
 * owns the provider-specific HTTP request + response normalization.
 */
export type ProviderFetchUsageSnapshotContext = {
  config: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
  provider: string;
  token: string;
  accountId?: string;
  authProfileId?: string;
  /** Non-secret plan metadata from the resolved credential (e.g. Claude "max"). */
  subscriptionType?: string;
  rateLimitTier?: string;
  /** Account email captured on the resolved credential, when known. */
  email?: string;
  timeoutMs: number;
  fetchFn: typeof fetch;
};

/**
 * Provider-owned auth-doctor hint input.
 *
 * Called when OAuth refresh fails and OpenClaw wants a provider-specific repair
 * hint to append to the generic re-auth message. Use this for legacy profile-id
 * migrations or other provider-owned auth-store cleanup guidance.
 */
export type ProviderAuthDoctorHintContext = {
  config?: OpenClawConfig;
  store: AuthProfileStore;
  provider: string;
  profileId?: string;
};

/**
 * Provider-owned extra-param normalization before OpenClaw builds its generic
 * stream option wrapper.
 *
 * Use this to set provider defaults or rewrite provider-specific config keys
 * into the merged `extraParams` object. Return the full next extraParams object.
 */
/** Provider-facing effort after OpenClaw lowers orchestration-only modes. */
export type ProviderTransportThinkingLevel = Exclude<ThinkLevel, "ultra">;

export type ProviderPrepareExtraParamsContext = {
  config?: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  agentId?: string;
  nativeWebSearchAllowedByToolPolicy?: boolean;
  provider: string;
  modelId: string;
  model?: ProviderRuntimeModel;
  extraParams?: Record<string, unknown>;
  thinkingLevel?: ProviderTransportThinkingLevel;
};

export type ProviderExtraParamsForTransportContext = Omit<
  ProviderPrepareExtraParamsContext,
  "extraParams"
> & {
  model?: ProviderRuntimeModel;
  transport?: "sse" | "websocket" | "auto";
  extraParams: Record<string, unknown>;
};

export type ProviderExtraParamsForTransportResult = {
  patch?: Record<string, unknown> | null;
};

export type ProviderResolvePromptOverlayContext = ProviderSystemPromptContributionContext & {
  baseOverlay?: ProviderSystemPromptContribution;
};

export type ProviderFollowupFallbackRouteContext = {
  config?: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  provider: string;
  modelId: string;
  payload: ReplyPayload;
  originatingChannel?: string;
  originatingTo?: string;
  originRoutable: boolean;
  dispatcherAvailable: boolean;
};

export type ProviderFollowupFallbackRouteResult = {
  route?: "origin" | "dispatcher" | "drop";
  reason?: string;
};

export type ProviderResolveAuthProfileIdContext = {
  config?: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  provider: string;
  modelId: string;
  preferredProfileId?: string;
  lockedProfileId?: string;
  profileOrder: string[];
  authStore: AuthProfileStore;
};

export type ProviderReplaySanitizeMode = "full" | "images-only";

export type ProviderReplayToolCallIdMode = "strict" | "strict9";

export type ProviderReasoningOutputMode = "native" | "tagged";

/**
 * @deprecated Legacy static provider capability bag.
 *
 * Core replay/runtime ownership now lives on explicit provider hooks such as
 * `buildReplayPolicy`, `normalizeToolSchemas`, and `wrapStreamFn`. OpenClaw no
 * longer reads this bag at runtime, but the field remains typed so existing
 * third-party plugins do not fail to compile immediately.
 */
export type ProviderCapabilities = Record<string, unknown>;

/**
 * Provider-owned replay/compaction transcript policy.
 *
 * These values are consumed by shared history replay and compaction logic.
 * Return only the fields the provider wants to override; core fills the rest
 * with its default policy.
 */
export type ProviderReplayPolicy = {
  sanitizeMode?: ProviderReplaySanitizeMode;
  sanitizeToolCallIds?: boolean;
  toolCallIdMode?: ProviderReplayToolCallIdMode;
  duplicateToolCallIdStyle?: "openai";
  preserveNativeAnthropicToolUseIds?: boolean;
  preserveSignatures?: boolean;
  sanitizeThoughtSignatures?: {
    allowBase64Only?: boolean;
    includeCamelCase?: boolean;
  };
  dropThinkingBlocks?: boolean;
  dropReasoningFromHistory?: boolean;
  repairToolUseResultPairing?: boolean;
  applyAssistantFirstOrderingFix?: boolean;
  validateGeminiTurns?: boolean;
  validateAnthropicTurns?: boolean;
  allowSyntheticToolResults?: boolean;
};

/**
 * Provider-owned replay/compaction policy input.
 *
 * Use this when transcript replay rules depend on provider/model transport
 * behavior and should stay with the provider plugin instead of core tables.
 */
export type ProviderReplayPolicyContext = {
  config?: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  provider: string;
  modelId?: string;
  modelApi?: string | null;
  model?: ProviderRuntimeModel;
};

export type ProviderReplaySessionEntry = {
  customType: string;
  data?: unknown;
};

export type ProviderReplaySessionState = {
  getCustomEntries(): ProviderReplaySessionEntry[];
  appendCustomEntry(customType: string, data: unknown): void;
};

/**
 * Provider-owned replay-history sanitization input.
 *
 * Runs after core applies generic transcript cleanup so plugins can make
 * provider-specific replay rewrites without owning the whole compaction flow.
 */
export type ProviderSanitizeReplayHistoryContext = ProviderReplayPolicyContext & {
  sessionId: string;
  messages: AgentMessage[];
  allowedToolNames?: Iterable<string>;
  sessionState?: ProviderReplaySessionState;
};

/**
 * Provider-owned final replay-turn validation input.
 *
 * Use this for providers that require strict turn ordering or additional
 * replay-time transcript validation beyond generic sanitation.
 */
export type ProviderValidateReplayTurnsContext = ProviderReplayPolicyContext & {
  sessionId?: string;
  messages: AgentMessage[];
  sessionState?: ProviderReplaySessionState;
};

/**
 * Provider-owned tool-schema normalization input.
 *
 * Runs before tool registration for replay/compaction/inference so providers
 * can rewrite schema keywords that their transport family does not support.
 */
export type ProviderNormalizeToolSchemasContext = ProviderReplayPolicyContext & {
  tools: AnyAgentTool[];
};

export type ProviderToolSchemaDiagnostic = {
  toolName: string;
  toolIndex?: number;
  violations: string[];
};

/**
 * Provider-owned reasoning output mode input.
 *
 * Use this when a provider requires a specific reasoning-output contract, such
 * as text tags instead of native structured reasoning fields.
 */
export type ProviderReasoningOutputModeContext = ProviderReplayPolicyContext;

/**
 * Provider-owned transport creation.
 *
 * Use this when the provider needs to replace shared model runtime's default transport with a
 * custom StreamFn (for example a native API transport that cannot be expressed
 * as a wrapper around `streamSimple`).
 */
export type ProviderCreateStreamFnContext = {
  config?: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  provider: string;
  modelId: string;
  model: ProviderRuntimeModel;
};

/**
 * Provider-owned stream wrapper hook after OpenClaw applies its generic
 * transport-independent wrappers.
 *
 * Use this for provider-specific payload/header/model mutations that still run
 * through the normal `shared model runtime` stream path.
 */
export type ProviderWrapStreamFnContext = ProviderPrepareExtraParamsContext & {
  model?: ProviderRuntimeModel;
  streamFn?: StreamFn;
};

/**
 * Provider-owned transport turn state.
 *
 * Use this for provider-native request headers or metadata that should stay
 * stable across retries while still being attached by generic core transports.
 */
export type ProviderTransportTurnState = {
  headers?: Record<string, string>;
  metadata?: Record<string, string>;
};

/**
 * Provider-owned request identity for transport turns.
 *
 * Use this when the provider exposes native request/session metadata that must
 * be attached by both HTTP and WebSocket transports.
 */
export type ProviderResolveTransportTurnStateContext = {
  provider: string;
  modelId: string;
  model?: ProviderRuntimeModel;
  sessionId?: string;
  turnId: string;
  attempt: number;
  transport: "stream" | "websocket";
};

/**
 * Provider-owned WebSocket session policy.
 *
 * Use this for session-scoped headers or cool-down behavior that should apply
 * before a generic WebSocket transport decides to retry or fall back.
 */
export type ProviderWebSocketSessionPolicy = {
  headers?: Record<string, string>;
  degradeCooldownMs?: number;
};

/**
 * Provider-owned WebSocket session policy input.
 *
 * Use this when the provider wants to control native session handshake headers
 * or the post-failure cool-down window for a generic WebSocket transport.
 */
export type ProviderResolveWebSocketSessionPolicyContext = {
  provider: string;
  modelId: string;
  model?: ProviderRuntimeModel;
  sessionId?: string;
};

/**
 * Provider-owned failover error classification input.
 *
 * Use this when provider-specific transport or API errors need classification
 * hints that generic string matching cannot express safely.
 */
export type ProviderFailoverErrorContext = {
  provider?: string;
  modelId?: string;
  errorMessage: string;
  status?: number;
  code?: string;
  errorType?: string;
};

/**
 * Generic embedding provider shape returned by provider plugins.
 *
 * Keep this aligned with the memory embedding contract without forcing the
 * plugin system to import memory internals directly.
 */
export type PluginEmbeddingProvider = {
  id: string;
  model: string;
  maxInputTokens?: number;
  embedQuery: (text: string, options?: { signal?: AbortSignal }) => Promise<number[]>;
  embedBatch: (texts: string[], options?: { signal?: AbortSignal }) => Promise<number[][]>;
  embedBatchInputs?: (inputs: unknown[], options?: { signal?: AbortSignal }) => Promise<number[][]>;
  client?: unknown;
};

/**
 * Provider-owned embedding transport creation.
 *
 * Use this when a provider wants memory embeddings to live with the provider
 * plugin instead of the core memory switchboard.
 */
export type ProviderCreateEmbeddingProviderContext = {
  config: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  provider: string;
  model: string;
  remote?: {
    baseUrl?: string;
    apiKey?: unknown;
    headers?: Record<string, string>;
  };
  providerApiKey?: string;
  inputType?: string;
  queryInputType?: string;
  documentInputType?: string;
  queryInstructionTemplate?: boolean;
  outputDimensionality?: number;
  taskType?: string;
};

/**
 * Provider-owned prompt-cache eligibility.
 *
 * Return `true` or `false` to override OpenClaw's built-in provider cache TTL
 * detection for this provider. Return `undefined` to fall back to core rules.
 */
export type ProviderCacheTtlEligibilityContext = {
  provider: string;
  modelId: string;
  modelApi?: string;
};

/**
 * Provider-owned missing-auth message override.
 *
 * Runs only after OpenClaw exhausts normal env/profile/config auth resolution
 * for the requested provider. Return a custom message to replace the generic
 * "No API key found" error.
 */
export type ProviderBuildMissingAuthMessageContext = {
  config?: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
  provider: string;
  listProfileIds: (providerId: string) => string[];
};

/**
 * Provider-owned unknown-model hint override.
 *
 * Runs after catalog/runtime lookup misses for the requested provider. Return a
 * hint suffix that OpenClaw should append to the generic `Unknown model`
 * error.
 */
export type ProviderBuildUnknownModelHintContext = {
  config?: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
  provider: string;
  modelId: string;
  baseUrl?: string;
};

/**
 * Built-in model suppression hook context.
 *
 * @deprecated Use manifest `modelCatalog.suppressions`. Runtime suppression
 * hooks are no longer called by model resolution.
 */
export type ProviderBuiltInModelSuppressionContext = {
  config?: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
  provider: string;
  modelId: string;
  baseUrl?: string;
};

export type ProviderBuiltInModelSuppressionResult = {
  suppress: boolean;
  errorMessage?: string;
};

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

// Explicit named rows mirror the type-star re-exports above for names the
// plugin-entry SDK facade consumes; the .d.ts bundler cannot resolve names
// through `export type *` and fails the build without them.
export type {
  MediaUnderstandingProviderPlugin,
  RealtimeTranscriptionProviderPlugin,
  SpeechProviderPlugin,
  TranscriptSourceProvider,
  WorkerLease,
  WorkerLeaseStatus,
  WorkerProfile,
  WorkerProvider,
  WorkerSshEndpoint,
  WorkerSshIdentity,
} from "./capability-provider.types.js";
export type {
  MigrationApplyResult,
  MigrationDetection,
  MigrationItem,
  MigrationPlan,
  MigrationProviderContext,
  MigrationProviderPlugin,
  MigrationSummary,
} from "./migration-provider.types.js";
export type { OpenClawPluginApi } from "./plugin-api.types.js";
export type {
  AgentPromptGuidance,
  AgentPromptGuidanceEntry,
  AgentPromptSurfaceKind,
  OpenClawPluginCommandDefinition,
  PluginCommandContext,
  PluginCommandResult,
} from "./plugin-command.types.js";
export type { OpenClawPluginConfigSchema } from "./plugin-config-schema.types.js";
export type { OpenClawPluginDefinition } from "./plugin-definition.types.js";
export type {
  OpenClawGatewayDiscoveryService,
  OpenClawPluginNodeInvokePolicy,
  OpenClawPluginNodeInvokePolicyContext,
  OpenClawPluginNodeInvokePolicyResult,
  OpenClawPluginReloadRegistration,
  OpenClawPluginSecurityAuditCollector,
  OpenClawPluginService,
  OpenClawPluginServiceContext,
} from "./plugin-registration.types.js";
export type {
  ProviderAuthContext,
  ProviderAuthMethod,
  ProviderAuthMethodNonInteractiveContext,
  ProviderAuthResult,
  ProviderDeferSyntheticProfileAuthContext,
} from "./provider-authentication.types.js";
export type {
  ProviderAugmentModelCatalogContext,
  ProviderBuiltInModelSuppressionContext,
  ProviderBuiltInModelSuppressionResult,
  ProviderCatalogContext,
  ProviderCatalogResult,
  ProviderModernModelPolicyContext,
  UnifiedModelCatalogProviderContext,
  UnifiedModelCatalogProviderPlugin,
} from "./provider-catalog.types.js";
export type {
  ProviderNormalizeToolSchemasContext,
  ProviderReasoningOutputMode,
  ProviderReasoningOutputModeContext,
  ProviderReplayPolicy,
  ProviderReplayPolicyContext,
  ProviderReplaySessionEntry,
  ProviderReplaySessionState,
  ProviderSanitizeReplayHistoryContext,
  ProviderToolSchemaDiagnostic,
  ProviderValidateReplayTurnsContext,
} from "./provider-replay.types.js";
export type {
  ProviderAuthDoctorHintContext,
  ProviderFetchUsageSnapshotContext,
  ProviderNormalizeModelIdContext,
  ProviderNormalizeResolvedModelContext,
  ProviderNormalizeTransportContext,
  ProviderPrepareDynamicModelContext,
  ProviderPrepareExtraParamsContext,
  ProviderPrepareRuntimeAuthContext,
  ProviderPreparedRuntimeAuth,
  ProviderResolveDynamicModelContext,
  ProviderResolveUsageAuthContext,
  ProviderResolvedUsageAuth,
} from "./provider-runtime.types.js";
export type {
  ProviderBuildMissingAuthMessageContext,
  ProviderBuildUnknownModelHintContext,
  ProviderCacheTtlEligibilityContext,
  ProviderFailoverErrorContext,
  ProviderResolveTransportTurnStateContext,
  ProviderResolveWebSocketSessionPolicyContext,
  ProviderTransportTurnState,
  ProviderWebSocketSessionPolicy,
  ProviderWrapStreamFnContext,
} from "./provider-transport.types.js";
export type {
  OpenClawGatewayDiscoveryAdvertiseContext,
  OpenClawPluginHttpRouteHandler,
  OpenClawPluginSecurityAuditContext,
} from "./plugin-registration.types.js";
export type { ProviderUsageAuthToken } from "./provider-runtime.types.js";
export type { WorkerSshIdentityRequest } from "./capability-provider.types.js";
export type {
  ImageGenerationProviderPlugin,
  MusicGenerationProviderPlugin,
  RealtimeVoiceProviderPlugin,
  VideoGenerationProviderPlugin,
} from "./capability-provider.types.js";
export type {
  OpenClawPluginCliCommandDescriptor,
  OpenClawPluginCliRegistrar,
  OpenClawPluginGatewayRuntimeScopeSurface,
  OpenClawPluginHostedMediaResolver,
  OpenClawPluginHttpRouteAuth,
  OpenClawPluginHttpRouteMatch,
  OpenClawPluginHttpRouteUpgradeHandler,
  PluginInteractiveHandlerRegistration,
  PluginRegistrationMode,
} from "./plugin-registration.types.js";
export type { PluginHookRegistration } from "./hook-types.js";
export type { PluginTextTransformRegistration } from "./plugin-api.types.js";
export type { ProviderCatalogOrder } from "./provider-catalog.types.js";
export type { ProviderPlugin } from "./provider-plugin.types.js";
