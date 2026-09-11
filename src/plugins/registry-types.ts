/** Shared registration types that make up the in-memory plugin registry. */
import type { AgentHarness, AgentHarnessNativeCompaction } from "../agents/harness/types.js";
import type { GatewayMethodDescriptor } from "../gateway/methods/descriptor.js";
import type { GatewayRequestHandlers } from "../gateway/server-methods/types.js";
import type { InternalHookHandler } from "../hooks/internal-hook-types.js";
import type { HookEntry } from "../hooks/types.js";
import type { JsonSchemaObject } from "../shared/json-schema.types.js";
import type { DetachedTaskLifecycleRuntimeRegistration } from "../tasks/detached-task-runtime-contract.js";
import type {
  AgentToolResultMiddleware,
  AgentToolResultMiddlewareRuntime,
  AgentToolResultMiddlewareScope,
} from "./agent-tool-result-middleware-types.js";
import type { PluginBoardWidgetContentKind } from "./board-widget-content-kind.types.js";
import type { CodexAppServerExtensionFactory } from "./codex-app-server-extension-types.js";
import type { PluginCompatCode } from "./compat/registry.js";
import type { PluginActivationSource } from "./config-state.js";
import type { EmbeddingProviderAdapter } from "./embedding-provider-types.js";
import type {
  PluginAgentEventSubscriptionRegistration,
  PluginControlUiDescriptor,
  PluginRuntimeLifecycleRegistration,
  PluginSessionActionRegistration,
  PluginSessionSchedulerJobRegistration,
  PluginSessionExtensionRegistration,
  PluginToolMetadataRegistration,
  PluginTrustedToolPolicyRegistration,
} from "./host-hooks.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import type {
  PluginBundleFormat,
  PluginConfigUiHint,
  PluginDiagnostic,
  PluginFormat,
  PluginManifestNativeSessionCatalogSetup,
} from "./manifest-types.js";
import type {
  PluginManifestContracts,
  PluginManifestControlUi,
  PluginManifestDashboard,
  PluginManifestDashboardActionVerb,
  PluginManifestDashboardDataBinding,
  PluginManifestMcpServer,
} from "./manifest.js";
import type { PluginKind } from "./plugin-kind.types.js";
import type { PluginProviderRegistration } from "./provider-plugin.types.js";
import type {
  ContextEngineRegistration,
  MemoryCorpusSupplementRegistration,
  MemoryPluginCapabilityRegistration,
  MemoryPromptPreparationRegistration,
  MemoryPromptSupplementRegistration,
  RegisteredCompactionProvider,
  ResolvedPluginRuntimeArtifact,
  SessionDiscussionProvider,
} from "./registry-contribution-types.js";
import type { PluginRuntime } from "./runtime/types.js";
import type { SessionCatalogProvider } from "./session-catalog.js";
import type { PluginDependencyStatus } from "./status-dependencies-core.js";
import type {
  OpenClawPluginHttpRouteAuth,
  OpenClawPluginHttpRouteUpgradeHandler,
} from "./types.js";
import type { PluginMcpServerConnectionResolverRegistration } from "./types.mcp-connection.js";
type ChannelPlugin = import("../channels/plugins/types.plugin.js").ChannelPlugin;
type CliBackendPlugin = import("./types.js").CliBackendPlugin;
type ImageGenerationProviderPlugin = import("./types.js").ImageGenerationProviderPlugin;
type MediaUnderstandingProviderPlugin = import("./types.js").MediaUnderstandingProviderPlugin;
type TranscriptSourceProvider = import("./types.js").TranscriptSourceProvider;
type MusicGenerationProviderPlugin = import("./types.js").MusicGenerationProviderPlugin;
type OpenClawPluginCliRootCommandDescriptor =
  import("./types.js").OpenClawPluginCliRootCommandDescriptor;
type OpenClawPluginCliRegistrar = import("./types.js").OpenClawPluginCliRegistrar;
type OpenClawPluginCommandDefinition = import("./types.js").OpenClawPluginCommandDefinition;
type PluginInteractiveHandlerRegistration =
  import("./types.js").PluginInteractiveHandlerRegistration;
type OpenClawPluginGatewayRuntimeScopeSurface =
  import("./types.js").OpenClawPluginGatewayRuntimeScopeSurface;
type OpenClawGatewayDiscoveryService = import("./types.js").OpenClawGatewayDiscoveryService;
type OpenClawPluginHttpRouteHandler = import("./types.js").OpenClawPluginHttpRouteHandler;
type OpenClawPluginHttpRouteMatch = import("./types.js").OpenClawPluginHttpRouteMatch;
type OpenClawPluginHostedMediaResolver = import("./types.js").OpenClawPluginHostedMediaResolver;
type OpenClawPluginReloadRegistration = import("./types.js").OpenClawPluginReloadRegistration;
type OpenClawPluginSecurityAuditCollector =
  import("./types.js").OpenClawPluginSecurityAuditCollector;
type OpenClawPluginService = import("./types.js").OpenClawPluginService;
type OpenClawPluginToolFactory = import("./types.js").OpenClawPluginToolFactory;
type PluginConversationBindingResolvedEvent =
  import("./types.js").PluginConversationBindingResolvedEvent;
type TypedPluginHookRegistration = import("./types.js").PluginHookRegistration;
type PluginLogger = import("./types.js").PluginLogger;
type PluginOrigin = import("./types.js").PluginOrigin;
type PluginTextTransformRegistration = import("./types.js").PluginTextTransformRegistration;
type MigrationProviderPlugin = import("./types.js").MigrationProviderPlugin;
type RealtimeTranscriptionProviderPlugin = import("./types.js").RealtimeTranscriptionProviderPlugin;
type RealtimeVoiceProviderPlugin = import("./types.js").RealtimeVoiceProviderPlugin;
type SpeechProviderPlugin = import("./types.js").SpeechProviderPlugin;
type VideoGenerationProviderPlugin = import("./types.js").VideoGenerationProviderPlugin;
type WebFetchProviderPlugin = import("./types.js").WebFetchProviderPlugin;
type WebSearchProviderPlugin = import("./types.js").WebSearchProviderPlugin;
type WorkerProvider = import("./types.js").WorkerProvider;
type UnifiedModelCatalogProviderPlugin = import("./types.js").UnifiedModelCatalogProviderPlugin;

/** Registration provenance; this shape carries no execution or resource authority. */
type PluginRegistrationOwner = {
  pluginId: string;
  pluginName?: string;
  source: string;
  rootDir?: string;
};

/** Agent tool factory registered by one plugin runtime. */
export type PluginToolRegistration = PluginRegistrationOwner & {
  factory: OpenClawPluginToolFactory;
  names: string[];
  declaredNames?: string[];
  optional: boolean;
  /** Loader-owned provenance. Missing values are conservative legacy registrations. */
  origin?: PluginOrigin;
};
type PluginCliRegistration = PluginRegistrationOwner & {
  register: OpenClawPluginCliRegistrar;
  parentPath: string[];
  commands: string[];
  descriptors: OpenClawPluginCliRootCommandDescriptor[];
};

/** Gateway HTTP route registered by a plugin runtime. */
export type PluginHttpRouteRegistration = {
  /** Retired ingress awaiting a lifecycle replacement; responds with Retry-After. */
  handoff?: true;
  pluginId?: string;
  path: string;
  handler: OpenClawPluginHttpRouteHandler;
  handleUpgrade?: OpenClawPluginHttpRouteUpgradeHandler;
  auth: OpenClawPluginHttpRouteAuth;
  match: OpenClawPluginHttpRouteMatch;
  gatewayRuntimeScopeSurface?: OpenClawPluginGatewayRuntimeScopeSurface;
  gatewayMethodDispatchAllowed?: boolean;
  nodeCapability?: {
    surface: string;
    ttlMs?: number;
  };
  source?: string;
};

type PluginHostedMediaResolverRegistration = PluginRegistrationOwner & {
  resolver: OpenClawPluginHostedMediaResolver;
};

export type PluginChannelRegistration = PluginRegistrationOwner & {
  plugin: ChannelPlugin;
  /** Exact record-bound runtime resolver captured when the active plugin registered the channel. */
  resolveChannelRuntime?: () => PluginRuntime["channel"];
  /** Loader-owned provenance. Missing values are conservative legacy registrations. */
  origin?: PluginOrigin;
};

type PluginChannelSetupRegistration = PluginRegistrationOwner & {
  plugin: ChannelPlugin;
  /** Loader-owned provenance. Missing values are conservative legacy registrations. */
  origin?: PluginOrigin;
  enabled: boolean;
};

type PluginModelCatalogProviderRegistration = PluginRegistrationOwner & {
  provider: UnifiedModelCatalogProviderPlugin;
};

type PluginSessionCatalogRegistration = PluginRegistrationOwner & {
  provider: SessionCatalogProvider;
};

export type PluginDashboardDataBindingRegistration = PluginManifestDashboardDataBinding & {
  pluginId: string;
  capabilityId: string;
  handler: GatewayRequestHandlers[string];
};

export type PluginDashboardActionVerbRegistration = PluginManifestDashboardActionVerb & {
  pluginId: string;
  capabilityId: string;
  handler: GatewayRequestHandlers[string];
};

export type PluginBoardWidgetContentKindRegistration = {
  pluginId: string;
  pluginKind: string;
  definition: PluginBoardWidgetContentKind;
};

type PluginCliBackendRegistration = PluginRegistrationOwner & {
  builtWithOpenClawVersion?: string;
  backend: CliBackendPlugin;
};

export type PluginTextTransformsRegistration = PluginRegistrationOwner & {
  transforms: PluginTextTransformRegistration;
};

export type PluginOwnedProviderRegistration<T extends { id: string }> = PluginRegistrationOwner & {
  provider: T;
};

type PluginSpeechProviderRegistration = PluginOwnedProviderRegistration<SpeechProviderPlugin>;
type PluginEmbeddingProviderRegistration =
  PluginOwnedProviderRegistration<EmbeddingProviderAdapter>;
type PluginRealtimeTranscriptionProviderRegistration =
  PluginOwnedProviderRegistration<RealtimeTranscriptionProviderPlugin>;
type PluginRealtimeVoiceProviderRegistration =
  PluginOwnedProviderRegistration<RealtimeVoiceProviderPlugin>;
type PluginMediaUnderstandingProviderRegistration =
  PluginOwnedProviderRegistration<MediaUnderstandingProviderPlugin>;
type PluginTranscriptsSourceProviderRegistration =
  PluginOwnedProviderRegistration<TranscriptSourceProvider>;
type PluginImageGenerationProviderRegistration =
  PluginOwnedProviderRegistration<ImageGenerationProviderPlugin>;
type PluginVideoGenerationProviderRegistration =
  PluginOwnedProviderRegistration<VideoGenerationProviderPlugin>;
type PluginMusicGenerationProviderRegistration =
  PluginOwnedProviderRegistration<MusicGenerationProviderPlugin>;
type PluginWebFetchProviderRegistration = PluginOwnedProviderRegistration<WebFetchProviderPlugin>;
type PluginWebSearchProviderRegistration = PluginOwnedProviderRegistration<WebSearchProviderPlugin>;
type PluginWorkerProviderRegistration = PluginOwnedProviderRegistration<WorkerProvider>;
type PluginMigrationProviderRegistration = PluginOwnedProviderRegistration<MigrationProviderPlugin>;
type PluginCodexAppServerExtensionFactoryRegistration = PluginRegistrationOwner & {
  rawFactory: CodexAppServerExtensionFactory;
  factory: CodexAppServerExtensionFactory;
};
export type PluginAgentToolResultMiddlewareRegistration = PluginRegistrationOwner & {
  rawHandler: AgentToolResultMiddleware;
  handler: AgentToolResultMiddleware;
  runtimes: AgentToolResultMiddlewareRuntime[];
  scopes?: AgentToolResultMiddlewareScope[];
};
export type PluginAgentToolResultMiddlewareOwner = {
  pluginId: string;
  runtimes: AgentToolResultMiddlewareRuntime[];
  manifest: PluginManifestRecord;
};
type PluginAgentHarnessRegistration = PluginRegistrationOwner & {
  harness: AgentHarness;
  nativeCompaction?: AgentHarnessNativeCompaction;
};

type PluginHookRegistration = {
  pluginId: string;
  entry: HookEntry;
  events: string[];
  source: string;
  rootDir?: string;
};

export type PluginServiceRegistration = PluginRegistrationOwner & {
  service: OpenClawPluginService;
  origin: PluginOrigin;
  trustedOfficialInstall?: boolean;
};

export type PluginGatewayDiscoveryServiceRegistration = PluginRegistrationOwner & {
  service: OpenClawGatewayDiscoveryService;
};

type PluginReloadRegistration = PluginRegistrationOwner & {
  registration: OpenClawPluginReloadRegistration;
};

export type PluginNodeHostCommandRegistration = PluginRegistrationOwner & {
  command: import("./types.js").OpenClawPluginNodeHostCommand;
};

type PluginNodeInvokePolicyRegistration = PluginRegistrationOwner & {
  policy: import("./types.js").OpenClawPluginNodeInvokePolicy;
  pluginConfig?: Record<string, unknown>;
};

export type PluginWidgetPresenterRegistration = PluginRegistrationOwner & {
  presenter: import("./plugin-registration.types.js").WidgetPresenter;
};

type PluginSecurityAuditCollectorRegistration = PluginRegistrationOwner & {
  collector: OpenClawPluginSecurityAuditCollector;
};

export type PluginCommandRegistration = PluginRegistrationOwner & {
  command: OpenClawPluginCommandDefinition;
  trustedOwnerStatusExposure?: true;
};

type PluginLegacyInternalHookRegistration = {
  pluginId: string;
  name: string;
  event: string;
  handler: InternalHookHandler;
};

type PluginSessionDiscussionRegistration = {
  pluginId: string;
  provider: SessionDiscussionProvider;
};

type PluginInteractiveHandlerRegistryRegistration = PluginInteractiveHandlerRegistration & {
  pluginId: string;
  pluginName?: string;
  pluginRoot?: string;
};

type PluginSessionExtensionRegistryRegistration = PluginRegistrationOwner & {
  extension: PluginSessionExtensionRegistration;
};

export type PluginTrustedToolPolicyRegistryRegistration = PluginRegistrationOwner & {
  policy: PluginTrustedToolPolicyRegistration;
  origin?: PluginRecord["origin"];
};

type PluginToolMetadataRegistryRegistration = PluginRegistrationOwner & {
  metadata: PluginToolMetadataRegistration;
};

type PluginControlUiDescriptorRegistryRegistration = PluginRegistrationOwner & {
  descriptor: PluginControlUiDescriptor;
};

type PluginRuntimeLifecycleRegistryRegistration = PluginRegistrationOwner & {
  lifecycle: PluginRuntimeLifecycleRegistration;
};

type PluginAgentEventSubscriptionRegistryRegistration = PluginRegistrationOwner & {
  subscription: PluginAgentEventSubscriptionRegistration;
};

type PluginSessionSchedulerJobRegistryRegistration = PluginRegistrationOwner & {
  job: PluginSessionSchedulerJobRegistration;
  generation?: number;
};

export type PluginSessionActionRegistryRegistration = PluginRegistrationOwner & {
  action: PluginSessionActionRegistration;
};

type PluginConversationBindingResolvedHandlerRegistration = PluginRegistrationOwner & {
  pluginRoot?: string;
  handler: (event: PluginConversationBindingResolvedEvent) => void | Promise<void>;
};

export type PluginRecord = {
  id: string;
  nativeSessionCatalog?: PluginManifestNativeSessionCatalogSetup;
  name: string;
  packageVersion?: string;
  version?: string;
  builtWithOpenClawVersion?: string;
  packageName?: string;
  description?: string;
  format?: PluginFormat;
  bundleFormat?: PluginBundleFormat;
  bundleCapabilities?: string[];
  kind?: PluginKind | PluginKind[];
  source: string;
  rootDir?: string;
  origin: PluginOrigin;
  workspaceDir?: string;
  trustedOfficialInstall?: boolean;
  trust?: import("./plugin-trust.js").PluginTrust;
  enabled: boolean;
  explicitlyEnabled?: boolean;
  activated?: boolean;
  imported?: boolean;
  /** Families authoritatively supplied by a descriptor entry, including empty collections. */
  capabilityCatalog?: Array<keyof import("./capability-catalog.types.js").PluginCapabilityCatalog>;
  compat?: readonly PluginCompatCode[];
  activationSource?: PluginActivationSource;
  activationReason?: string;
  status: "loaded" | "disabled" | "error";
  error?: string;
  failedAt?: Date;
  failurePhase?: "validation" | "load" | "register";
  toolNames: string[];
  hookNames: string[];
  channelIds: string[];
  cliBackendIds: string[];
  providerIds: string[];
  syntheticAuthRefs?: string[];
  embeddingProviderIds: string[];
  speechProviderIds: string[];
  realtimeTranscriptionProviderIds: string[];
  realtimeVoiceProviderIds: string[];
  mediaUnderstandingProviderIds: string[];
  transcriptSourceProviderIds: string[];
  imageGenerationProviderIds: string[];
  videoGenerationProviderIds: string[];
  musicGenerationProviderIds: string[];
  webFetchProviderIds: string[];
  webSearchProviderIds: string[];
  migrationProviderIds: string[];
  contextEngineIds?: string[];
  agentHarnessIds: string[];
  cliCommands: string[];
  services: string[];
  gatewayDiscoveryServiceIds: string[];
  commands: string[];
  commandAliases?: PluginManifestRecord["commandAliases"];
  httpRoutes: number;
  hookCount: number;
  configSchema: boolean;
  configUiHints?: Record<string, PluginConfigUiHint>;
  configJsonSchema?: JsonSchemaObject;
  contracts?: PluginManifestContracts;
  dashboard?: PluginManifestDashboard;
  controlUi?: PluginManifestControlUi;
  mcpServers?: Record<string, PluginManifestMcpServer>;
  memorySlotSelected?: boolean;
  dependencyStatus?: PluginDependencyStatus;
};

export type PluginRegistry = {
  plugins: PluginRecord[];
  tools: PluginToolRegistration[];
  hooks: PluginHookRegistration[];
  typedHooks: TypedPluginHookRegistration[];
  channels: PluginChannelRegistration[];
  channelSetups: PluginChannelSetupRegistration[];
  providers: PluginProviderRegistration[];
  modelCatalogProviders: PluginModelCatalogProviderRegistration[];
  sessionCatalogs: PluginSessionCatalogRegistration[];
  cliBackends: PluginCliBackendRegistration[];
  textTransforms: PluginTextTransformsRegistration[];
  embeddingProviders: PluginEmbeddingProviderRegistration[];
  speechProviders: PluginSpeechProviderRegistration[];
  realtimeTranscriptionProviders: PluginRealtimeTranscriptionProviderRegistration[];
  realtimeVoiceProviders: PluginRealtimeVoiceProviderRegistration[];
  mediaUnderstandingProviders: PluginMediaUnderstandingProviderRegistration[];
  transcriptSourceProviders: PluginTranscriptsSourceProviderRegistration[];
  imageGenerationProviders: PluginImageGenerationProviderRegistration[];
  videoGenerationProviders: PluginVideoGenerationProviderRegistration[];
  musicGenerationProviders: PluginMusicGenerationProviderRegistration[];
  webFetchProviders: PluginWebFetchProviderRegistration[];
  webSearchProviders: PluginWebSearchProviderRegistration[];
  workerProviders: Map<string, PluginWorkerProviderRegistration>;
  migrationProviders: PluginMigrationProviderRegistration[];
  codexAppServerExtensionFactories: PluginCodexAppServerExtensionFactoryRegistration[];
  agentToolResultMiddlewareOwners: PluginAgentToolResultMiddlewareOwner[];
  agentToolResultMiddlewares: PluginAgentToolResultMiddlewareRegistration[];
  agentHarnesses: PluginAgentHarnessRegistration[];
  pluginRuntimeArtifacts: Map<string, ResolvedPluginRuntimeArtifact>;
  compactionProviders: RegisteredCompactionProvider[];
  detachedTaskRuntimes: DetachedTaskLifecycleRuntimeRegistration[];
  legacyInternalHooks: PluginLegacyInternalHookRegistration[];
  memoryCapabilities: MemoryPluginCapabilityRegistration[];
  memoryCorpusSupplements: MemoryCorpusSupplementRegistration[];
  memoryPromptPreparations: MemoryPromptPreparationRegistration[];
  memoryPromptSupplements: MemoryPromptSupplementRegistration[];
  sessionDiscussionProviders: Map<string, PluginSessionDiscussionRegistration>;
  contextEngines: Map<string, ContextEngineRegistration>;
  gatewayHandlers: GatewayRequestHandlers;
  gatewayMethodDescriptors: GatewayMethodDescriptor[];
  dashboardDataBindings: Map<string, PluginDashboardDataBindingRegistration>;
  dashboardActionVerbs: Map<string, PluginDashboardActionVerbRegistration>;
  boardWidgetContentKinds: Map<string, PluginBoardWidgetContentKindRegistration>;
  coreGatewayMethodNames: string[];
  httpRoutes: PluginHttpRouteRegistration[];
  hostedMediaResolvers: PluginHostedMediaResolverRegistration[];
  widgetPresenters: PluginWidgetPresenterRegistration[];
  mcpServerConnectionResolvers: PluginMcpServerConnectionResolverRegistration[];
  cliRegistrars: PluginCliRegistration[];
  reloads: PluginReloadRegistration[];
  nodeHostCommands: PluginNodeHostCommandRegistration[];
  nodeInvokePolicies: PluginNodeInvokePolicyRegistration[];
  securityAuditCollectors: PluginSecurityAuditCollectorRegistration[];
  services: PluginServiceRegistration[];
  gatewayDiscoveryServices: PluginGatewayDiscoveryServiceRegistration[];
  commands: PluginCommandRegistration[];
  interactiveHandlers: PluginInteractiveHandlerRegistryRegistration[];
  sessionExtensions: PluginSessionExtensionRegistryRegistration[];
  trustedToolPolicies: PluginTrustedToolPolicyRegistryRegistration[];
  toolMetadata: PluginToolMetadataRegistryRegistration[];
  controlUiDescriptors: PluginControlUiDescriptorRegistryRegistration[];
  runtimeLifecycles: PluginRuntimeLifecycleRegistryRegistration[];
  agentEventSubscriptions: PluginAgentEventSubscriptionRegistryRegistration[];
  sessionSchedulerJobs: PluginSessionSchedulerJobRegistryRegistration[];
  sessionActions: PluginSessionActionRegistryRegistration[];
  conversationBindingResolvedHandlers: PluginConversationBindingResolvedHandlerRegistration[];
  diagnostics: PluginDiagnostic[];
};

export type PluginRegistryParams = {
  logger: PluginLogger;
  coreGatewayHandlers?: GatewayRequestHandlers;
  coreGatewayMethodNames?: readonly string[];
  runtime: PluginRuntime;
  /** Synchronous factory binding supplied by loaders or direct registry composition roots. */
  resolveCapabilityCatalogContext?: () => import("./capability-catalog-context.types.js").PluginCapabilityCatalogContext;
  /** Process-owner policy for registering catalogs that may fall back to HOME. */
  allowProcessHomeSessionCatalogs?: boolean;
  hostServices?: {
    /** May be a live accessor; plugin APIs must read it at call time. */
    cron?: import("../cron/service-contract.js").CronServiceContract;
  };
  activateGlobalSideEffects?: boolean;
};
