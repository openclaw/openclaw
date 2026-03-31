import type {
  ImageGenerationProviderPlugin,
  MediaUnderstandingProviderPlugin,
  ProviderPlugin,
  SpeechProviderPlugin,
} from "../../../src/plugins/types.js";
import { createTestPluginApi } from "./plugin-api.js";

type RegisteredProviderCollections = {
  providers: ProviderPlugin[];
  speechProviders: SpeechProviderPlugin[];
  mediaProviders: MediaUnderstandingProviderPlugin[];
  imageProviders: ImageGenerationProviderPlugin[];
};

type ProviderPluginModule = {
  register(api: ReturnType<typeof createTestPluginApi>): void;
};

export function registerProviderPlugin(params: {
  plugin: ProviderPluginModule;
  id: string;
  name: string;
}): RegisteredProviderCollections {
  const providers: ProviderPlugin[] = [];
  const speechProviders: SpeechProviderPlugin[] = [];
  const mediaProviders: MediaUnderstandingProviderPlugin[] = [];
  const imageProviders: ImageGenerationProviderPlugin[] = [];

  params.plugin.register(
    createTestPluginApi({
      id: params.id,
      name: params.name,
      source: "test",
      config: {},
      runtime: {} as never,
      registerProvider: (provider) => {
        providers.push(provider);
      },
      registerSpeechProvider: (provider) => {
        speechProviders.push(provider);
      },
      registerMediaUnderstandingProvider: (provider) => {
        mediaProviders.push(provider);
      },
      registerImageGenerationProvider: (provider) => {
        imageProviders.push(provider);
      },
    }),
  );

  return { providers, speechProviders, mediaProviders, imageProviders };
}

export function requireRegisteredProvider<T extends { id: string }>(
  entries: T[],
  id: string,
  label = "provider",
): T {
  const entry = entries.find((candidate) => candidate.id === id);
  if (!entry) {
    throw new Error(`${label} ${id} was not registered`);
  }
  return entry;
}
