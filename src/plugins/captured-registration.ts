import type { OpenClawConfig } from "../config/config.js";
import { buildPluginApi } from "./api-builder.js";
import type { PluginRuntime } from "./runtime/types.js";
import type {
  AnyAgentTool,
  CliBackendPlugin,
  ImageGenerationProviderPlugin,
  MediaUnderstandingProviderPlugin,
  OpenClawPluginApi,
  OpenClawPluginCliCommandDescriptor,
  OpenClawPluginCliRegistrar,
  ProviderPlugin,
  RealtimeTranscriptionProviderPlugin,
  RealtimeVoiceProviderPlugin,
  SpeechProviderPlugin,
  VideoGenerationProviderPlugin,
  WebFetchProviderPlugin,
  WebSearchProviderPlugin,
} from "./types.js";

type CapturedPluginCliRegistration = {
  register: OpenClawPluginCliRegistrar;
  commands: string[];
  descriptors: OpenClawPluginCliCommandDescriptor[];
};

export type CapturedPluginRegistration = {
  api: OpenClawPluginApi;
  providers: ProviderPlugin[];
  cliRegistrars: CapturedPluginCliRegistration[];
  cliBackends: CliBackendPlugin[];
  speechProviders: SpeechProviderPlugin[];
  realtimeTranscriptionProviders: RealtimeTranscriptionProviderPlugin[];
  realtimeVoiceProviders: RealtimeVoiceProviderPlugin[];
  mediaUnderstandingProviders: MediaUnderstandingProviderPlugin[];
  imageGenerationProviders: ImageGenerationProviderPlugin[];
  videoGenerationProviders: VideoGenerationProviderPlugin[];
  webFetchProviders: WebFetchProviderPlugin[];
  webSearchProviders: WebSearchProviderPlugin[];
  tools: AnyAgentTool[];
};

export function createCapturedPluginRegistration(params?: {
  config?: OpenClawConfig;
  registrationMode?: OpenClawPluginApi["registrationMode"];
}): CapturedPluginRegistration {
  const providers: ProviderPlugin[] = [];
  const cliRegistrars: CapturedPluginCliRegistration[] = [];
  const cliBackends: CliBackendPlugin[] = [];
  const speechProviders: SpeechProviderPlugin[] = [];
  const realtimeTranscriptionProviders: RealtimeTranscriptionProviderPlugin[] = [];
  const realtimeVoiceProviders: RealtimeVoiceProviderPlugin[] = [];
  const mediaUnderstandingProviders: MediaUnderstandingProviderPlugin[] = [];
  const imageGenerationProviders: ImageGenerationProviderPlugin[] = [];
  const videoGenerationProviders: VideoGenerationProviderPlugin[] = [];
  const webFetchProviders: WebFetchProviderPlugin[] = [];
  const webSearchProviders: WebSearchProviderPlugin[] = [];
  const tools: AnyAgentTool[] = [];
  const noopLogger = {
    info() {},
    warn() {},
    error() {},
    debug() {},
  };

  return {
    providers,
    cliRegistrars,
    cliBackends,
    speechProviders,
    realtimeTranscriptionProviders,
    realtimeVoiceProviders,
    mediaUnderstandingProviders,
    imageGenerationProviders,
    videoGenerationProviders,
    webFetchProviders,
    webSearchProviders,
    tools,
    api: buildPluginApi({
      id: "captured-plugin-registration",
      name: "Captured Plugin Registration",
      source: "captured-plugin-registration",
      registrationMode: params?.registrationMode ?? "full",
      config: params?.config ?? ({} as OpenClawConfig),
      runtime: {} as PluginRuntime,
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
        registerProvider(provider: ProviderPlugin) {
          providers.push(provider);
        },
        registerCliBackend(backend: CliBackendPlugin) {
          cliBackends.push(backend);
        },
        registerSpeechProvider(provider: SpeechProviderPlugin) {
          speechProviders.push(provider);
        },
        registerRealtimeTranscriptionProvider(provider: RealtimeTranscriptionProviderPlugin) {
          realtimeTranscriptionProviders.push(provider);
        },
        registerRealtimeVoiceProvider(provider: RealtimeVoiceProviderPlugin) {
          realtimeVoiceProviders.push(provider);
        },
        registerMediaUnderstandingProvider(provider: MediaUnderstandingProviderPlugin) {
          mediaUnderstandingProviders.push(provider);
        },
        registerImageGenerationProvider(provider: ImageGenerationProviderPlugin) {
          imageGenerationProviders.push(provider);
        },
        registerVideoGenerationProvider(provider: VideoGenerationProviderPlugin) {
          videoGenerationProviders.push(provider);
        },
        registerWebFetchProvider(provider: WebFetchProviderPlugin) {
          webFetchProviders.push(provider);
        },
        registerWebSearchProvider(provider: WebSearchProviderPlugin) {
          webSearchProviders.push(provider);
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

export function capturePluginRegistration(params: {
  register(api: OpenClawPluginApi): void;
}): CapturedPluginRegistration {
  const captured = createCapturedPluginRegistration();
  params.register(captured.api);
  return captured;
}
