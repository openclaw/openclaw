import type {
  AnyAgentTool,
  MediaUnderstandingProviderPlugin,
  OpenClawPluginApi,
  ProviderPlugin,
  SpeechProviderPlugin,
  WebSearchProviderPlugin,
} from "../plugins/types.js";

export type CapturedPluginRegistration = {
  api: OpenClawPluginApi;
  providers: ProviderPlugin[];
  speechProviders: SpeechProviderPlugin[];
  mediaUnderstandingProviders: MediaUnderstandingProviderPlugin[];
  webSearchProviders: WebSearchProviderPlugin[];
  tools: AnyAgentTool[];
};

export function createCapturedPluginRegistration(): CapturedPluginRegistration {
  const providers: ProviderPlugin[] = [];
  const speechProviders: SpeechProviderPlugin[] = [];
  const mediaUnderstandingProviders: MediaUnderstandingProviderPlugin[] = [];
  const webSearchProviders: WebSearchProviderPlugin[] = [];
  const tools: AnyAgentTool[] = [];

  return {
    providers,
    speechProviders,
    mediaUnderstandingProviders,
    webSearchProviders,
    tools,
    api: {
      registerProvider(provider: ProviderPlugin) {
        providers.push(provider);
      },
      registerSpeechProvider(provider: SpeechProviderPlugin) {
        speechProviders.push(provider);
      },
      registerMediaUnderstandingProvider(provider: MediaUnderstandingProviderPlugin) {
        mediaUnderstandingProviders.push(provider);
      },
      registerWebSearchProvider(provider: WebSearchProviderPlugin) {
        webSearchProviders.push(provider);
      },
      registerTool(tool: AnyAgentTool) {
        tools.push(tool);
      },
    } as OpenClawPluginApi,
  };
}

export function registerSingleProviderPlugin(params: {
  register(api: OpenClawPluginApi): void;
}): ProviderPlugin {
  const captured = createCapturedPluginRegistration();
  params.register(captured.api);
  const provider = captured.providers[0];
  if (!provider) {
    throw new Error("provider registration missing");
  }
  return provider;
}
