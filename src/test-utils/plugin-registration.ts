import type {
  OpenClawPluginApi,
  ProviderPlugin,
  WebSearchProviderPlugin,
} from "../plugins/types.js";

export type CapturedPluginRegistration = {
  api: OpenClawPluginApi;
  providers: ProviderPlugin[];
  webSearchProviders: WebSearchProviderPlugin[];
};

export function createCapturedPluginRegistration(): CapturedPluginRegistration {
  const providers: ProviderPlugin[] = [];
  const webSearchProviders: WebSearchProviderPlugin[] = [];

  return {
    providers,
    webSearchProviders,
    api: {
      registerProvider(provider: ProviderPlugin) {
        providers.push(provider);
      },
      registerWebSearchProvider(provider: WebSearchProviderPlugin) {
        webSearchProviders.push(provider);
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
