import type {
  ImageGenerationProviderPlugin,
  MediaUnderstandingProviderPlugin,
  ProviderPlugin,
  SpeechProviderPlugin,
  VideoGenerationProviderPlugin,
} from "../../../src/plugins/types.js";
import { createTestPluginApi } from "./plugin-api.js";

type RegisteredProviderCollections = {
  providers: ProviderPlugin[];
  speechProviders: SpeechProviderPlugin[];
  mediaProviders: MediaUnderstandingProviderPlugin[];
  imageProviders: ImageGenerationProviderPlugin[];
  videoProviders: VideoGenerationProviderPlugin[];
};

type ProviderPluginModule = {
  register(api: ReturnType<typeof createTestPluginApi>): void | Promise<void>;
};

export async function registerProviderPlugin(params: {
  plugin: ProviderPluginModule;
  id: string;
  name: string;
}): Promise<RegisteredProviderCollections> {
  const providers: ProviderPlugin[] = [];
  const speechProviders: SpeechProviderPlugin[] = [];
  const mediaProviders: MediaUnderstandingProviderPlugin[] = [];
  const imageProviders: ImageGenerationProviderPlugin[] = [];
  const videoProviders: VideoGenerationProviderPlugin[] = [];

  await params.plugin.register(
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
      registerVideoGenerationProvider: (provider) => {
        videoProviders.push(provider);
      },
    }),
  );

  return { providers, speechProviders, mediaProviders, imageProviders, videoProviders };
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
