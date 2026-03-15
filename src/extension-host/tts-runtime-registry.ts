import type { TtsProvider } from "../config/types.tts.js";
import type { ResolvedTtsConfig } from "./tts-config.js";

export type ExtensionHostTtsRuntimeProvider = {
  id: TtsProvider;
  supportsTelephony: boolean;
  resolveApiKey: (config: ResolvedTtsConfig) => string | undefined;
  isConfigured: (config: ResolvedTtsConfig) => boolean;
};

const EXTENSION_HOST_TTS_RUNTIME_PROVIDERS: readonly ExtensionHostTtsRuntimeProvider[] = [
  {
    id: "openai",
    supportsTelephony: true,
    resolveApiKey(config) {
      return config.openai.apiKey || process.env.OPENAI_API_KEY;
    },
    isConfigured(config) {
      return Boolean(this.resolveApiKey(config));
    },
  },
  {
    id: "elevenlabs",
    supportsTelephony: true,
    resolveApiKey(config) {
      return config.elevenlabs.apiKey || process.env.ELEVENLABS_API_KEY || process.env.XI_API_KEY;
    },
    isConfigured(config) {
      return Boolean(this.resolveApiKey(config));
    },
  },
  {
    id: "edge",
    supportsTelephony: false,
    resolveApiKey() {
      return undefined;
    },
    isConfigured(config) {
      return config.edge.enabled;
    },
  },
] as const;

export const EXTENSION_HOST_TTS_PROVIDER_IDS = EXTENSION_HOST_TTS_RUNTIME_PROVIDERS.map(
  (provider) => provider.id,
) as readonly TtsProvider[];

export function listExtensionHostTtsRuntimeProviders(): readonly ExtensionHostTtsRuntimeProvider[] {
  return EXTENSION_HOST_TTS_RUNTIME_PROVIDERS;
}

export function getExtensionHostTtsRuntimeProvider(
  id: TtsProvider,
): ExtensionHostTtsRuntimeProvider | undefined {
  return EXTENSION_HOST_TTS_RUNTIME_PROVIDERS.find((provider) => provider.id === id);
}

export function resolveExtensionHostTtsApiKey(
  config: ResolvedTtsConfig,
  provider: TtsProvider,
): string | undefined {
  return getExtensionHostTtsRuntimeProvider(provider)?.resolveApiKey(config);
}

export function isExtensionHostTtsProviderConfigured(
  config: ResolvedTtsConfig,
  provider: TtsProvider,
): boolean {
  return getExtensionHostTtsRuntimeProvider(provider)?.isConfigured(config) ?? false;
}

export function resolveExtensionHostTtsProviderOrder(primary: TtsProvider): TtsProvider[] {
  return [primary, ...EXTENSION_HOST_TTS_PROVIDER_IDS.filter((provider) => provider !== primary)];
}

export function supportsExtensionHostTtsTelephony(provider: TtsProvider): boolean {
  return getExtensionHostTtsRuntimeProvider(provider)?.supportsTelephony ?? false;
}
