import { normalizeAgentToolResultMiddlewareRuntimes } from "./agent-tool-result-middleware.js";
import { buildPluginApi } from "./api-builder.js";
export function createCapturedPluginRegistration(params) {
    const providers = [];
    const agentHarnesses = [];
    const cliRegistrars = [];
    const cliBackends = [];
    const textTransforms = [];
    const codexAppServerExtensionFactories = [];
    const agentToolResultMiddlewares = [];
    const speechProviders = [];
    const realtimeTranscriptionProviders = [];
    const realtimeVoiceProviders = [];
    const mediaUnderstandingProviders = [];
    const imageGenerationProviders = [];
    const videoGenerationProviders = [];
    const musicGenerationProviders = [];
    const webFetchProviders = [];
    const webSearchProviders = [];
    const memoryEmbeddingProviders = [];
    const tools = [];
    const noopLogger = {
        info() { },
        warn() { },
        error() { },
        debug() { },
    };
    return {
        providers,
        agentHarnesses,
        cliRegistrars,
        cliBackends,
        textTransforms,
        codexAppServerExtensionFactories,
        agentToolResultMiddlewares,
        speechProviders,
        realtimeTranscriptionProviders,
        realtimeVoiceProviders,
        mediaUnderstandingProviders,
        imageGenerationProviders,
        videoGenerationProviders,
        musicGenerationProviders,
        webFetchProviders,
        webSearchProviders,
        memoryEmbeddingProviders,
        tools,
        api: buildPluginApi({
            id: "captured-plugin-registration",
            name: "Captured Plugin Registration",
            source: "captured-plugin-registration",
            registrationMode: params?.registrationMode ?? "full",
            config: params?.config ?? {},
            runtime: {},
            logger: noopLogger,
            resolvePath: (input) => input,
            handlers: {
                registerCli(registrar, opts) {
                    const descriptors = (opts?.descriptors ?? [])
                        .map((descriptor) => ({
                        name: descriptor.name.trim(),
                        description: descriptor.description.trim(),
                        hasSubcommands: descriptor.hasSubcommands,
                    }))
                        .filter((descriptor) => descriptor.name && descriptor.description);
                    const commands = [
                        ...(opts?.commands ?? []),
                        ...descriptors.map((descriptor) => descriptor.name),
                    ]
                        .map((command) => command.trim())
                        .filter(Boolean);
                    if (commands.length === 0) {
                        return;
                    }
                    cliRegistrars.push({
                        register: registrar,
                        commands,
                        descriptors,
                    });
                },
                registerProvider(provider) {
                    providers.push(provider);
                },
                registerAgentHarness(harness) {
                    agentHarnesses.push(harness);
                },
                registerCodexAppServerExtensionFactory(factory) {
                    codexAppServerExtensionFactories.push(factory);
                },
                registerAgentToolResultMiddleware(handler, options) {
                    const runtimes = normalizeAgentToolResultMiddlewareRuntimes(options);
                    agentToolResultMiddlewares.push({
                        pluginId: "captured-plugin-registration",
                        pluginName: "Captured Plugin Registration",
                        rawHandler: handler,
                        handler,
                        runtimes,
                        source: "captured-plugin-registration",
                    });
                },
                registerCliBackend(backend) {
                    cliBackends.push(backend);
                },
                registerTextTransforms(transforms) {
                    textTransforms.push(transforms);
                },
                registerSpeechProvider(provider) {
                    speechProviders.push(provider);
                },
                registerRealtimeTranscriptionProvider(provider) {
                    realtimeTranscriptionProviders.push(provider);
                },
                registerRealtimeVoiceProvider(provider) {
                    realtimeVoiceProviders.push(provider);
                },
                registerMediaUnderstandingProvider(provider) {
                    mediaUnderstandingProviders.push(provider);
                },
                registerImageGenerationProvider(provider) {
                    imageGenerationProviders.push(provider);
                },
                registerVideoGenerationProvider(provider) {
                    videoGenerationProviders.push(provider);
                },
                registerMusicGenerationProvider(provider) {
                    musicGenerationProviders.push(provider);
                },
                registerWebFetchProvider(provider) {
                    webFetchProviders.push(provider);
                },
                registerWebSearchProvider(provider) {
                    webSearchProviders.push(provider);
                },
                registerMemoryEmbeddingProvider(adapter) {
                    memoryEmbeddingProviders.push(adapter);
                },
                registerTool(tool) {
                    if (typeof tool !== "function") {
                        tools.push(tool);
                    }
                },
            },
        }),
    };
}
export function capturePluginRegistration(params) {
    const captured = createCapturedPluginRegistration();
    params.register(captured.api);
    return captured;
}
