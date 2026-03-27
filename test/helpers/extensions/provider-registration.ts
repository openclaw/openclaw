import { createTestPluginApi } from "./plugin-api.js";

type RegisteredProviderCollections = {
  providers: unknown[];
  speechProviders: unknown[];
  mediaProviders: unknown[];
  imageProviders: unknown[];
};

type ProviderPluginModule = {
  register(api: ReturnType<typeof createTestPluginApi>): void;
};

export function registerProviderPlugin(params: {
  plugin: ProviderPluginModule;
  id: string;
  name: string;
}): RegisteredProviderCollections {
  const providers: unknown[] = [];
  const speechProviders: unknown[] = [];
  const mediaProviders: unknown[] = [];
  const imageProviders: unknown[] = [];

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

export function requireRegisteredProvider<T = unknown>(
  entries: unknown[],
  id: string,
  label = "provider",
): T {
  const entry = entries.find(
    (candidate) =>
      // oxlint-disable-next-line typescript/no-explicit-any
      (candidate as any).id === id,
  );
  if (!entry) {
    throw new Error(`${label} ${id} was not registered`);
  }
  return entry as T;
}
