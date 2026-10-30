import type { AgentHarness, AgentHarnessNativeCompaction } from "../agents/harness/types.js";
import type { GatewayMethodDescriptor } from "../gateway/methods/descriptor.js";
import type { GatewayRequestHandlers } from "../gateway/server-methods/types.js";
import type { InternalHookHandler } from "../hooks/internal-hook-types.js";
import type { JsonSchemaObject } from "../shared/json-schema.types.js";
import type {
  AgentToolResultMiddleware,
  AgentToolResultMiddlewareRuntime,
  AgentToolResultMiddlewareScope,
} from "./agent-tool-result-middleware-types.js";
import type { PluginCompatCode } from "./compat/registry.js";
import type { PluginActivationSource } from "./config-activation-shared.js";
import type { EmbeddingProviderAdapter } from "./embedding-provider-types.js";
import type { PluginGatewayAccessPolicy } from "./gateway-access-policy.types.js";
import type { HookRunnerRegistry } from "./hook-registry.types.js";
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
import type { PluginManifestRecord } from "./manifest-registry.types.js";
import type {
  PluginBundleFormat,
  PluginConfigUiHint,
  PluginDiagnostic,
  PluginFormat,
  PluginManifestNativeSessionCatalogSetup,
  PluginManifestContracts,
  PluginManifestControlUi,
  PluginManifestDashboard,
  PluginManifestDashboardActionVerb,
  PluginManifestDashboardDataBinding,
  PluginManifestMcpServer,
} from "./manifest-types.js";
import type { PluginInstanceExecution } from "./plugin-instance.types.js";
import type { PluginKind } from "./plugin-kind.types.js";
import type {
  OpenClawPluginGatewayRuntimeScopeSurface,
  OpenClawPluginHttpRouteAuth,
  OpenClawPluginHttpRouteUpgradeHandler,
} from "./plugin-registration.types.js";
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
import type { PluginDependencyStatus } from "./status-dependencies.types.js";
import type { PluginMcpServerConnectionResolverRegistration } from "./types.mcp-connection.js";
type AnyChannelPlugin = import("../channels/plugins/types.plugin.js").AnyChannelPlugin;
type PluginOrigin = import("./types.js").PluginOrigin;
/** Registration provenance; this shape carries no execution or resource authority. */
type PluginRegistrationOwner = {
  pluginId: string;
  pluginName?: string;
  source: string;
  rootDir?: string;
};

/** Agent tool factory registered by one plugin runtime. */
export type PluginToolRegistration = PluginRegistrationOwner & {
  factory: import("./types.js").OpenClawPluginToolFactory;
  /** Explicitly registered required-authority context, never inferred from plugin identity. */
  contextVersion?: 2;
  names: string[];
  declaredNames?: ReadonlySet<string>;
  optional: boolean;
  workspaceAccess?: boolean | "execute";
  /** Shown only while one of `names` is callable; see listToolPromptGuidance. */
  promptGuidance?: string;
  /** Loader-owned provenance. Missing values are conservative legacy registrations. */
  origin?: PluginOrigin;
};
/** Gateway HTTP route registered by a plugin runtime. */
export type PluginHttpRouteRegistration = {
  /** Retired ingress awaiting a lifecycle replacement; responds with Retry-After. */
  handoff?: true;
  /** Compatibility endpoints retained by live holders or route handoffs. */
  legacyListeners?: readonly {
    port: number;
    host?: string;
    /** Shipped listener-liveness response: exact raw path, status 200, body "ok". */
    health?: { path: string; contentType?: string };
    /** Shipped Node HTTP deadlines in milliseconds; omission keeps Node defaults. */
    timeouts?: { headers: number; request: number; socket: number };
  }[];
  /** Endpoints retained only by a handoff, without a live holder. */
  legacyListenerHandoffs?: PluginHttpRouteRegistration["legacyListeners"];
  pluginId?: string;
  path: string;
  handler: import("./types.js").OpenClawPluginHttpRouteHandler;
  handleUpgrade?: OpenClawPluginHttpRouteUpgradeHandler;
  auth: OpenClawPluginHttpRouteAuth;
  match: import("./types.js").OpenClawPluginHttpRouteMatch;
  gatewayRuntimeScopeSurface?: OpenClawPluginGatewayRuntimeScopeSurface;
  gatewayMethodDispatchAllowed?: boolean;
  nodeCapability?: {
    surface: string;
    ttlMs?: number;
  };
  source?: string;
};

export type PluginChannelRegistration = PluginRegistrationOwner & {
  plugin: AnyChannelPlugin;
  /** Prepared views retain the exact transport donor in addition to their local admission. */
  borrowedRuntimeRecord?: PluginRecord;
  /** Exact record-bound runtime resolver captured when the active plugin registered the channel. */
  resolveChannelRuntime?: () => PluginRuntime["channel"];
  /** Loader-owned provenance. Missing values are conservative legacy registrations. */
  origin?: PluginOrigin;
  /** Host-owned capture of the exact verified official channel registration. */
  captureReadAuthority?: () => (() => boolean) | undefined;
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

export type PluginOwnedProviderRegistration<T> = PluginRegistrationOwner & {
  provider: T;
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
export type PluginServiceRegistration = PluginRegistrationOwner & {
  readonly id: string;
  service:
    | import("./types.js").OpenClawPluginService
    | import("./types.js").OpenClawPluginServiceV2;
  origin: PluginOrigin;
  trustedOfficialInstall?: boolean;
};

export type PluginGatewayDiscoveryServiceRegistration = PluginRegistrationOwner & {
  readonly id: string;
  service: import("./types.js").OpenClawGatewayDiscoveryService;
  instance?: PluginInstanceExecution;
};

export type PluginNodeHostCommandRegistration = PluginRegistrationOwner & {
  command: import("./types.js").OpenClawPluginNodeHostCommand;
};

export type PluginWidgetPresenterRegistration = PluginRegistrationOwner & {
  presenter: import("./plugin-registration.types.js").WidgetPresenter;
};

export type PluginCommandRegistration = PluginRegistrationOwner & {
  command: import("./types.js").OpenClawPluginCommandDefinition;
  trustedOwnerStatusExposure?: true;
};

export type PluginTrustedToolPolicyRegistryRegistration = PluginRegistrationOwner & {
  policy: PluginTrustedToolPolicyRegistration;
  origin?: PluginRecord["origin"];
};

export type PluginSessionActionRegistryRegistration = PluginRegistrationOwner & {
  action: PluginSessionActionRegistration;
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
  declaredContextEngineIds?: readonly string[];
  /** Manifest `reload.turnHandover`: a reload hands this generation's running turns to the next one. */
  turnHandover?: boolean;
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
  uiCapabilities?: PluginManifestRecord["uiCapabilities"];
  mcpServers?: Record<string, PluginManifestMcpServer>;
  memorySlotSelected?: boolean;
  dependencyStatus?: PluginDependencyStatus;
};

/** The Gateway registry owner that admitted work in a registry generation. */
export type PluginRegistryGatewayOwner = {
  /** The owner's published registry while it stays open; closing owners return undefined. */
  readonly current: () => PluginRegistry | undefined;
};

export type PluginRegistry = {
  plugins: PluginRecord[];
  tools: PluginToolRegistration[];
  hooks: HookRunnerRegistry["hooks"][number][];
  typedHooks: import("./types.js").PluginHookRegistration[];
  channels: PluginChannelRegistration[];
  channelSetups: (PluginRegistrationOwner & {
    plugin: AnyChannelPlugin;
    /** Loader-owned provenance. Missing values are conservative legacy registrations. */
    origin?: PluginOrigin;
    enabled: boolean;
  })[];
  providers: PluginProviderRegistration[];
  modelCatalogProviders: PluginOwnedProviderRegistration<
    import("./types.js").UnifiedModelCatalogProviderPlugin
  >[];
  sessionCatalogs: PluginOwnedProviderRegistration<SessionCatalogProvider>[];
  cliBackends: (PluginRegistrationOwner & {
    builtWithOpenClawVersion?: string;
    backend: import("./types.js").CliBackendPlugin;
  })[];
  embeddingProviders: PluginOwnedProviderRegistration<EmbeddingProviderAdapter>[];
  speechProviders: PluginOwnedProviderRegistration<import("./types.js").SpeechProviderPlugin>[];
  realtimeTranscriptionProviders: PluginOwnedProviderRegistration<
    import("./types.js").RealtimeTranscriptionProviderPlugin
  >[];
  realtimeVoiceProviders: PluginOwnedProviderRegistration<
    import("./types.js").RealtimeVoiceProviderPlugin
  >[];
  mediaUnderstandingProviders: PluginOwnedProviderRegistration<
    import("./types.js").MediaUnderstandingProviderPlugin
  >[];
  transcriptSourceProviders: PluginOwnedProviderRegistration<
    import("./types.js").TranscriptSourceProvider
  >[];
  imageGenerationProviders: PluginOwnedProviderRegistration<
    import("./types.js").ImageGenerationProviderPlugin
  >[];
  videoGenerationProviders: PluginOwnedProviderRegistration<
    import("./types.js").VideoGenerationProviderPlugin
  >[];
  musicGenerationProviders: PluginOwnedProviderRegistration<
    import("./types.js").MusicGenerationProviderPlugin
  >[];
  webFetchProviders: PluginOwnedProviderRegistration<import("./types.js").WebFetchProviderPlugin>[];
  webSearchProviders: PluginOwnedProviderRegistration<
    import("./types.js").WebSearchProviderPlugin
  >[];
  workerProviders: Map<
    string,
    PluginOwnedProviderRegistration<import("./types.js").WorkerProvider>
  >;
  storageProviders: Map<
    string,
    PluginOwnedProviderRegistration<import("../storage/types.js").StorageProvider>
  >;
  migrationProviders: PluginOwnedProviderRegistration<
    import("./types.js").MigrationProviderPlugin
  >[];
  agentToolResultMiddlewareOwners: PluginAgentToolResultMiddlewareOwner[];
  agentToolResultMiddlewares: PluginAgentToolResultMiddlewareRegistration[];
  agentHarnesses: (PluginRegistrationOwner & {
    harness: AgentHarness;
    nativeCompaction?: AgentHarnessNativeCompaction;
  })[];
  pluginRuntimeArtifacts: Map<string, ResolvedPluginRuntimeArtifact>;
  compactionProviders: RegisteredCompactionProvider[];
  decisionProviders: Array<{
    pluginId: string;
    host: import("../decisions/provider-host.js").DecisionProviderHost;
  }>;
  legacyInternalHooks: {
    pluginId: string;
    name: string;
    event: string;
    handler: InternalHookHandler;
  }[];
  memoryCapabilities: MemoryPluginCapabilityRegistration[];
  memoryCorpusSupplements: MemoryCorpusSupplementRegistration[];
  memoryPromptPreparations: MemoryPromptPreparationRegistration[];
  memoryPromptSupplements: MemoryPromptSupplementRegistration[];
  sessionDiscussionProviders: Map<
    string,
    {
      pluginId: string;
      provider: SessionDiscussionProvider;
    }
  >;
  contextEngines: Map<string, ContextEngineRegistration>;
  gatewayHandlers: GatewayRequestHandlers;
  gatewayMethodDescriptors: GatewayMethodDescriptor[];
  dashboardDataBindings: Map<string, PluginDashboardDataBindingRegistration>;
  dashboardActionVerbs: Map<string, PluginDashboardActionVerbRegistration>;
  coreGatewayMethodNames: string[];
  httpRoutes: PluginHttpRouteRegistration[];
  widgetPresenters: PluginWidgetPresenterRegistration[];
  mcpServerConnectionResolvers: PluginMcpServerConnectionResolverRegistration[];
  cliRegistrars: (PluginRegistrationOwner & {
    register: import("./types.js").OpenClawPluginCliRegistrar;
    parentPath: string[];
    commands: string[];
    descriptors: import("./types.js").OpenClawPluginCliRootCommandDescriptor[];
  })[];
  reloads: Array<
    PluginRegistrationOwner & {
      registration: import("./types.js").OpenClawPluginReloadRegistration;
    }
  >;
  nodeHostCommands: PluginNodeHostCommandRegistration[];
  nodeInvokePolicies: (PluginRegistrationOwner & {
    policy: import("./types.js").OpenClawPluginNodeInvokePolicy;
    pluginConfig?: Record<string, unknown>;
  })[];
  gatewayAccessPolicies: Array<PluginRegistrationOwner & { policy: PluginGatewayAccessPolicy }>;
  securityAuditCollectors: Array<
    PluginRegistrationOwner & {
      collector: import("./types.js").OpenClawPluginSecurityAuditCollector;
    }
  >;
  services: PluginServiceRegistration[];
  gatewayDiscoveryServices: PluginGatewayDiscoveryServiceRegistration[];
  commands: PluginCommandRegistration[];
  subagentProfiles: import("./subagent-profile.types.js").RegisteredSubagentProfile[];
  interactiveHandlers: (import("./types.js").PluginInteractiveHandlerRegistration & {
    pluginId: string;
    pluginName?: string;
    pluginRoot?: string;
  })[];
  sessionExtensions: Array<
    PluginRegistrationOwner & { extension: PluginSessionExtensionRegistration }
  >;
  trustedToolPolicies: PluginTrustedToolPolicyRegistryRegistration[];
  toolMetadata: Array<PluginRegistrationOwner & { metadata: PluginToolMetadataRegistration }>;
  controlUiDescriptors: Array<
    PluginRegistrationOwner & {
      descriptor: PluginControlUiDescriptor;
    }
  >;
  runtimeLifecycles: Array<
    PluginRegistrationOwner & { lifecycle: PluginRuntimeLifecycleRegistration }
  >;
  agentEventSubscriptions: Array<
    PluginRegistrationOwner & { subscription: PluginAgentEventSubscriptionRegistration }
  >;
  sessionSchedulerJobs: (PluginRegistrationOwner & {
    job: PluginSessionSchedulerJobRegistration;
    generation?: number;
  })[];
  sessionActions: PluginSessionActionRegistryRegistration[];
  conversationBindingResolvedHandlers: (PluginRegistrationOwner & {
    pluginRoot?: string;
    handler: (
      event: import("./types.js").PluginConversationBindingResolvedEvent,
    ) => void | Promise<void>;
  })[];
  diagnostics: PluginDiagnostic[];
};

export type PluginRegistryParams = {
  logger: import("./types.js").PluginLogger;
  coreGatewayHandlers?: GatewayRequestHandlers;
  coreGatewayMethodNames?: readonly string[];
  runtime: PluginRuntime;
  /** Synchronous factory binding supplied by loaders or direct registry composition roots. */
  resolveCapabilityCatalogContext?: () => import("./capability-catalog-context.types.js").PluginCapabilityCatalogHostContext;
  /** Process-owner policy for registering catalogs that may fall back to HOME. */
  allowProcessHomeSessionCatalogs?: boolean;
  hostServices?: {
    /** May be a live accessor; plugin APIs must read it at call time. */
    cron?: import("../cron/service-contract.js").CronServiceContract;
  };
  activateGlobalSideEffects?: boolean;
};
