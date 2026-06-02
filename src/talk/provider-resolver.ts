import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveConfiguredCapabilityProvider } from "../plugin-sdk/provider-selection-runtime.js";
import type { RealtimeVoiceProviderPlugin } from "../plugins/types.js";
import { getRealtimeVoiceProvider, listRealtimeVoiceProviders } from "./provider-registry.js";
import type { RealtimeVoiceProviderConfig } from "./provider-types.js";

export type ResolvedRealtimeVoiceProvider = {
  /** Registered realtime voice provider selected for the call/session. */
  provider: RealtimeVoiceProviderPlugin;
  /** Provider config after defaults, caller overrides, and provider normalization. */
  providerConfig: RealtimeVoiceProviderConfig;
};

export type ResolveConfiguredRealtimeVoiceProviderParams = {
  /** Explicit provider id from config or caller selection; absent means auto-select. */
  configuredProviderId?: string;
  /** Raw per-provider configs keyed by provider id. */
  providerConfigs?: Record<string, Record<string, unknown> | undefined>;
  /** Last-writer overrides used by runtime call setup after provider defaults are loaded. */
  providerConfigOverrides?: Record<string, unknown>;
  /** Full config used for registered-provider lookup and provider configuration checks. */
  cfg?: OpenClawConfig;
  /** Optional alternate config used only by the shared capability-provider resolver. */
  cfgForResolve?: OpenClawConfig;
  /** Test/injection provider list; absent uses the registered realtime voice providers. */
  providers?: RealtimeVoiceProviderPlugin[];
  /** Model inserted only when the raw provider config does not already specify one. */
  defaultModel?: string;
  /** Caller-facing error text when no realtime voice providers are registered. */
  noRegisteredProviderMessage?: string;
};

/** Selects and configures the realtime voice provider for one runtime voice session. */
export function resolveConfiguredRealtimeVoiceProvider(
  params: ResolveConfiguredRealtimeVoiceProviderParams,
): ResolvedRealtimeVoiceProvider {
  const cfgForResolve = params.cfgForResolve ?? params.cfg ?? ({} as OpenClawConfig);
  const providers = params.providers ?? listRealtimeVoiceProviders(params.cfg);
  const resolution = resolveConfiguredCapabilityProvider({
    configuredProviderId: params.configuredProviderId,
    providerConfigs: params.providerConfigs,
    cfg: params.cfg,
    cfgForResolve,
    getConfiguredProvider: (providerId) =>
      params.providers?.find((entry) => entry.id === providerId) ??
      getRealtimeVoiceProvider(providerId, params.cfg),
    listProviders: () => providers,
    resolveProviderConfig: ({ provider, cfg, rawConfig }) => {
      // Provider defaults should see the default model, but caller overrides must still win.
      const rawConfigWithModel =
        params.defaultModel && rawConfig.model === undefined
          ? { ...rawConfig, model: params.defaultModel }
          : rawConfig;
      const rawConfigWithOverrides = {
        ...rawConfigWithModel,
        ...params.providerConfigOverrides,
      };
      return (
        provider.resolveConfig?.({ cfg, rawConfig: rawConfigWithOverrides }) ??
        rawConfigWithOverrides
      );
    },
    isProviderConfigured: ({ provider, cfg, providerConfig }) =>
      provider.isConfigured({ cfg, providerConfig }),
  });

  if (!resolution.ok && resolution.code === "missing-configured-provider") {
    throw new Error(
      `Realtime voice provider "${resolution.configuredProviderId}" is not registered`,
    );
  }
  if (!resolution.ok && resolution.code === "no-registered-provider") {
    throw new Error(params.noRegisteredProviderMessage ?? "No realtime voice provider registered");
  }
  if (!resolution.ok) {
    throw new Error(`Realtime voice provider "${resolution.provider?.id}" is not configured`);
  }

  return {
    provider: resolution.provider,
    providerConfig: resolution.providerConfig,
  };
}
