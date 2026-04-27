const noopRegisterTool = () => { };
const noopRegisterHook = () => { };
const noopRegisterHttpRoute = () => { };
const noopRegisterChannel = () => { };
const noopRegisterGatewayMethod = () => { };
const noopRegisterCli = () => { };
const noopRegisterReload = () => { };
const noopRegisterNodeHostCommand = () => { };
const noopRegisterSecurityAuditCollector = () => { };
const noopRegisterService = () => { };
const noopRegisterGatewayDiscoveryService = () => { };
const noopRegisterCliBackend = () => { };
const noopRegisterTextTransforms = () => { };
const noopRegisterConfigMigration = () => { };
const noopRegisterAutoEnableProbe = () => { };
const noopRegisterProvider = () => { };
const noopRegisterSpeechProvider = () => { };
const noopRegisterRealtimeTranscriptionProvider = () => { };
const noopRegisterRealtimeVoiceProvider = () => { };
const noopRegisterMediaUnderstandingProvider = () => { };
const noopRegisterImageGenerationProvider = () => { };
const noopRegisterVideoGenerationProvider = () => { };
const noopRegisterMusicGenerationProvider = () => { };
const noopRegisterWebFetchProvider = () => { };
const noopRegisterWebSearchProvider = () => { };
const noopRegisterInteractiveHandler = () => { };
const noopOnConversationBindingResolved = () => { };
const noopRegisterCommand = () => { };
const noopRegisterContextEngine = () => { };
const noopRegisterCompactionProvider = () => { };
const noopRegisterAgentHarness = () => { };
const noopRegisterCodexAppServerExtensionFactory = () => { };
const noopRegisterAgentToolResultMiddleware = () => { };
const noopRegisterDetachedTaskRuntime = () => { };
const noopRegisterMemoryCapability = () => { };
const noopRegisterMemoryPromptSection = () => { };
const noopRegisterMemoryPromptSupplement = () => { };
const noopRegisterMemoryCorpusSupplement = () => { };
const noopRegisterMemoryFlushPlan = () => { };
const noopRegisterMemoryRuntime = () => { };
const noopRegisterMemoryEmbeddingProvider = () => { };
const noopOn = () => { };
export function buildPluginApi(params) {
    const handlers = params.handlers ?? {};
    return {
        id: params.id,
        name: params.name,
        version: params.version,
        description: params.description,
        source: params.source,
        rootDir: params.rootDir,
        registrationMode: params.registrationMode,
        config: params.config,
        pluginConfig: params.pluginConfig,
        runtime: params.runtime,
        logger: params.logger,
        registerTool: handlers.registerTool ?? noopRegisterTool,
        registerHook: handlers.registerHook ?? noopRegisterHook,
        registerHttpRoute: handlers.registerHttpRoute ?? noopRegisterHttpRoute,
        registerChannel: handlers.registerChannel ?? noopRegisterChannel,
        registerGatewayMethod: handlers.registerGatewayMethod ?? noopRegisterGatewayMethod,
        registerCli: handlers.registerCli ?? noopRegisterCli,
        registerReload: handlers.registerReload ?? noopRegisterReload,
        registerNodeHostCommand: handlers.registerNodeHostCommand ?? noopRegisterNodeHostCommand,
        registerSecurityAuditCollector: handlers.registerSecurityAuditCollector ?? noopRegisterSecurityAuditCollector,
        registerService: handlers.registerService ?? noopRegisterService,
        registerGatewayDiscoveryService: handlers.registerGatewayDiscoveryService ?? noopRegisterGatewayDiscoveryService,
        registerCliBackend: handlers.registerCliBackend ?? noopRegisterCliBackend,
        registerTextTransforms: handlers.registerTextTransforms ?? noopRegisterTextTransforms,
        registerConfigMigration: handlers.registerConfigMigration ?? noopRegisterConfigMigration,
        registerAutoEnableProbe: handlers.registerAutoEnableProbe ?? noopRegisterAutoEnableProbe,
        registerProvider: handlers.registerProvider ?? noopRegisterProvider,
        registerSpeechProvider: handlers.registerSpeechProvider ?? noopRegisterSpeechProvider,
        registerRealtimeTranscriptionProvider: handlers.registerRealtimeTranscriptionProvider ?? noopRegisterRealtimeTranscriptionProvider,
        registerRealtimeVoiceProvider: handlers.registerRealtimeVoiceProvider ?? noopRegisterRealtimeVoiceProvider,
        registerMediaUnderstandingProvider: handlers.registerMediaUnderstandingProvider ?? noopRegisterMediaUnderstandingProvider,
        registerImageGenerationProvider: handlers.registerImageGenerationProvider ?? noopRegisterImageGenerationProvider,
        registerVideoGenerationProvider: handlers.registerVideoGenerationProvider ?? noopRegisterVideoGenerationProvider,
        registerMusicGenerationProvider: handlers.registerMusicGenerationProvider ?? noopRegisterMusicGenerationProvider,
        registerWebFetchProvider: handlers.registerWebFetchProvider ?? noopRegisterWebFetchProvider,
        registerWebSearchProvider: handlers.registerWebSearchProvider ?? noopRegisterWebSearchProvider,
        registerInteractiveHandler: handlers.registerInteractiveHandler ?? noopRegisterInteractiveHandler,
        onConversationBindingResolved: handlers.onConversationBindingResolved ?? noopOnConversationBindingResolved,
        registerCommand: handlers.registerCommand ?? noopRegisterCommand,
        registerContextEngine: handlers.registerContextEngine ?? noopRegisterContextEngine,
        registerCompactionProvider: handlers.registerCompactionProvider ?? noopRegisterCompactionProvider,
        registerAgentHarness: handlers.registerAgentHarness ?? noopRegisterAgentHarness,
        registerCodexAppServerExtensionFactory: handlers.registerCodexAppServerExtensionFactory ?? noopRegisterCodexAppServerExtensionFactory,
        registerAgentToolResultMiddleware: handlers.registerAgentToolResultMiddleware ?? noopRegisterAgentToolResultMiddleware,
        registerDetachedTaskRuntime: handlers.registerDetachedTaskRuntime ?? noopRegisterDetachedTaskRuntime,
        registerMemoryCapability: handlers.registerMemoryCapability ?? noopRegisterMemoryCapability,
        registerMemoryPromptSection: handlers.registerMemoryPromptSection ?? noopRegisterMemoryPromptSection,
        registerMemoryPromptSupplement: handlers.registerMemoryPromptSupplement ?? noopRegisterMemoryPromptSupplement,
        registerMemoryCorpusSupplement: handlers.registerMemoryCorpusSupplement ?? noopRegisterMemoryCorpusSupplement,
        registerMemoryFlushPlan: handlers.registerMemoryFlushPlan ?? noopRegisterMemoryFlushPlan,
        registerMemoryRuntime: handlers.registerMemoryRuntime ?? noopRegisterMemoryRuntime,
        registerMemoryEmbeddingProvider: handlers.registerMemoryEmbeddingProvider ?? noopRegisterMemoryEmbeddingProvider,
        resolvePath: params.resolvePath,
        on: handlers.on ?? noopOn,
    };
}
