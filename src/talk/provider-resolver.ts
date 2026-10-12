/**
 * Realtime voice provider selection and config resolution.
 *
 * This adapter applies the generic capability-provider resolver to Talk
 * providers, including default model injection and per-call config overrides.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveConfiguredCapabilityProvider,
  resolveConfiguredCapabilityProviderAsync,
} from "../plugin-sdk/provider-selection-runtime.js";
import type { RealtimeVoiceProviderPlugin } from "../plugins/types.js";
import {
  readInternalRealtimeVoiceProviderApi,
  type InternalRealtimeVoiceProviderCapabilities,
} from "./provider-internal.js";
import { getRealtimeVoiceProvider, listRealtimeVoiceProviders } from "./provider-registry.js";
import type {
  RealtimeVoiceBrowserSessionCreateRequest,
  RealtimeVoiceProviderConfig,
  RealtimeVoiceProviderResolveConfigContext,
} from "./provider-types.js";

/** Resolved realtime voice provider plus provider-normalized config. */
export type ResolvedRealtimeVoiceProvider = {
  provider: RealtimeVoiceProviderPlugin;
  providerConfig: RealtimeVoiceProviderConfig;
  capabilities?: InternalRealtimeVoiceProviderCapabilities;
};

/** Inputs for resolving a configured or auto-selected realtime voice provider. */
export type ResolveConfiguredRealtimeVoiceProviderParams = {
  configuredProviderId?: string;
  providerConfigs?: Record<string, Record<string, unknown> | undefined>;
  /** Last-mile overrides from a session/client request. */
  providerConfigOverrides?: Record<string, unknown>;
  cfg?: OpenClawConfig;
  /** Alternate config object used by generic provider selection internals. */
  cfgForResolve?: OpenClawConfig;
  /** Agent whose browser-session auth store should be inspected. */
  agentId?: string;
  /** Test/runtime override for the provider list. */
  providers?: RealtimeVoiceProviderPlugin[];
  /** Availability gate checked before auto-candidate config normalization. */
  isProviderAvailable?: (provider: RealtimeVoiceProviderPlugin) => boolean;
  /** Raises the capability-specific error when no automatic provider is available. */
  assertProviderAvailable?: (provider: RealtimeVoiceProviderPlugin) => void;
  /** Model injected before provider-specific resolveConfig runs. */
  defaultModel?: string;
  /** Retain the provider's default when adding a transport to an existing consumer. */
  useProviderDefaultModel?: boolean;
  /** Runtime surface being selected. Defaults to the provider bridge path. */
  surface?: RealtimeVoiceProviderResolveConfigContext["surface"];
  autoRespondToAudio?: RealtimeVoiceProviderResolveConfigContext["autoRespondToAudio"];
  requiredCapabilities?: RealtimeVoiceProviderResolveConfigContext["requiredCapabilities"];
  clientControl?: RealtimeVoiceBrowserSessionCreateRequest["clientControl"];
  noRegisteredProviderMessage?: string;
};

function resolveRealtimeVoiceProviderCapabilities(params: {
  provider: RealtimeVoiceProviderPlugin;
  providerConfig: RealtimeVoiceProviderConfig;
  cfg?: OpenClawConfig;
  /** Host-selected agent scope for provider capability evaluation. */
  agentId?: string;
  /** Effective per-session model after request overrides. */
  model?: string;
  clientControl?: RealtimeVoiceBrowserSessionCreateRequest["clientControl"];
  surface?: "browser-session" | "gateway-relay" | "bridge";
}): InternalRealtimeVoiceProviderCapabilities | undefined {
  const capabilities =
    params.surface === "browser-session"
      ? readInternalRealtimeVoiceProviderApi(params.provider)?.resolveBrowserSessionCapabilities?.({
          cfg: params.cfg,
          providerConfig: params.providerConfig,
          agentId: params.agentId,
          model: params.model,
          ...(params.clientControl ? { clientControl: params.clientControl } : {}),
        })
      : params.surface === "gateway-relay"
        ? readInternalRealtimeVoiceProviderApi(params.provider)?.resolveGatewayRelayCapabilities?.({
            cfg: params.cfg,
            providerConfig: params.providerConfig,
            model: params.model,
          })
        : undefined;
  return capabilities || params.provider.capabilities;
}

function isRealtimeVoiceProviderConfigured(params: {
  provider: RealtimeVoiceProviderPlugin;
  cfg?: OpenClawConfig;
  providerConfig: RealtimeVoiceProviderConfig;
  agentId?: string;
  surface?: "browser-session" | "gateway-relay" | "bridge";
}): boolean {
  const internalConfigured =
    params.surface === "browser-session"
      ? readInternalRealtimeVoiceProviderApi(params.provider)?.isBrowserSessionConfigured({
          cfg: params.cfg,
          providerConfig: params.providerConfig,
          agentId: params.agentId,
        })
      : params.surface === "gateway-relay"
        ? readInternalRealtimeVoiceProviderApi(params.provider)?.isGatewayRelayConfigured?.({
            cfg: params.cfg,
            providerConfig: params.providerConfig,
            agentId: params.agentId,
          })
        : undefined;
  if (internalConfigured !== undefined) {
    return internalConfigured;
  }
  return (
    params.provider.isConfigured?.({
      cfg: params.cfg,
      agentId: params.agentId,
      providerConfig: params.providerConfig,
    }) ?? false
  );
}

export async function resolveRealtimeVoiceProviderCapabilitiesAsync(params: {
  provider: RealtimeVoiceProviderPlugin;
  providerConfig: RealtimeVoiceProviderConfig;
  cfg?: OpenClawConfig;
  /** Host-selected agent scope for provider capability evaluation. */
  agentId?: string;
  /** Effective per-session model after request overrides. */
  model?: string;
  clientControl?: RealtimeVoiceBrowserSessionCreateRequest["clientControl"];
  surface?: "browser-session" | "gateway-relay" | "bridge";
}): Promise<InternalRealtimeVoiceProviderCapabilities | undefined> {
  const internal = readInternalRealtimeVoiceProviderApi(params.provider);
  const context = {
    cfg: params.cfg,
    providerConfig: params.providerConfig,
    agentId: params.agentId,
    model: params.model,
    ...(params.clientControl ? { clientControl: params.clientControl } : {}),
  };
  const capabilities =
    params.surface === "browser-session" && internal?.resolveBrowserSessionCapabilitiesAsync
      ? await internal.resolveBrowserSessionCapabilitiesAsync(context)
      : resolveRealtimeVoiceProviderCapabilities(params);

  return capabilities || params.provider.capabilities;
}

export async function isRealtimeVoiceProviderConfiguredAsync(params: {
  provider: RealtimeVoiceProviderPlugin;
  cfg?: OpenClawConfig;
  providerConfig: RealtimeVoiceProviderConfig;
  agentId?: string;
  surface?: "browser-session" | "gateway-relay" | "bridge";
}): Promise<boolean> {
  const internal = readInternalRealtimeVoiceProviderApi(params.provider);
  const context = {
    cfg: params.cfg,
    providerConfig: params.providerConfig,
    agentId: params.agentId,
  };
  const configured =
    params.surface === "browser-session"
      ? internal?.isBrowserSessionConfiguredAsync
        ? await internal.isBrowserSessionConfiguredAsync(context)
        : internal?.isBrowserSessionConfigured(context)
      : params.surface === "gateway-relay"
        ? internal?.isGatewayRelayConfiguredAsync
          ? await internal.isGatewayRelayConfiguredAsync(context)
          : internal?.isGatewayRelayConfigured?.(context)
        : undefined;
  if (configured !== undefined) {
    return configured;
  }
  return params.provider.isConfiguredAsync
    ? await params.provider.isConfiguredAsync(context)
    : (params.provider.isConfigured?.(context) ?? false);
}

/** @deprecated Use resolveConfiguredRealtimeVoiceProviderAsync for stored-credential providers. */
export function resolveConfiguredRealtimeVoiceProvider(
  params: ResolveConfiguredRealtimeVoiceProviderParams,
): ResolvedRealtimeVoiceProvider {
  const cfgForResolve = params.cfgForResolve ?? params.cfg ?? {};
  const resolution = resolveConfiguredCapabilityProvider({
    configuredProviderId: params.configuredProviderId,
    providerConfigs: params.providerConfigs,
    cfg: params.cfg,
    cfgForResolve,
    getConfiguredProvider: (providerId) =>
      params.providers?.find((entry) => entry.id === providerId) ??
      getRealtimeVoiceProvider(providerId, params.cfg),
    listProviders: () =>
      params.providers ??
      listRealtimeVoiceProviders(params.cfg, Object.keys(params.providerConfigs ?? {})),
    isProviderAvailable: params.isProviderAvailable
      ? ({ provider }) => params.isProviderAvailable?.(provider) === true
      : undefined,
    resolveProviderConfig: ({ provider, cfg, rawConfig }) => {
      // Provider config resolution should see the default model as if it came
      // from config, while explicit provider config still wins.
      const defaultModel =
        params.defaultModel ?? (params.useProviderDefaultModel ? provider.defaultModel : undefined);
      const rawConfigWithModel =
        defaultModel && rawConfig.model === undefined
          ? { ...rawConfig, model: defaultModel }
          : rawConfig;
      const rawConfigWithOverrides = {
        ...rawConfigWithModel,
        ...params.providerConfigOverrides,
      };
      // Per-call overrides are applied before provider normalization so provider
      // implementations can validate and coerce them consistently.
      return (
        provider.resolveConfig?.({
          cfg,
          rawConfig: rawConfigWithOverrides,
          agentId: params.agentId,
          surface: params.surface,
          autoRespondToAudio: params.autoRespondToAudio,
          requiredCapabilities: params.requiredCapabilities,
        }) ?? rawConfigWithOverrides
      );
    },
    isProviderConfigured: ({ provider, cfg, providerConfig }) =>
      isRealtimeVoiceProviderConfigured({
        provider,
        cfg,
        providerConfig,
        agentId: params.agentId,
        surface: params.surface,
      }),
  });

  if (!resolution.ok && resolution.code === "missing-configured-provider") {
    throw new Error(
      `Realtime voice provider "${resolution.configuredProviderId}" is not registered`,
    );
  }
  if (!resolution.ok && resolution.code === "no-registered-provider") {
    throw new Error(params.noRegisteredProviderMessage ?? "No realtime voice provider registered");
  }
  if (!resolution.ok && resolution.code === "provider-unavailable" && resolution.provider) {
    params.assertProviderAvailable?.(resolution.provider);
    throw new Error(`Realtime voice provider "${resolution.provider.id}" is unavailable`);
  }
  if (!resolution.ok) {
    throw new Error(`Realtime voice provider "${resolution.provider?.id}" is not configured`);
  }

  return {
    provider: resolution.provider,
    providerConfig: resolution.providerConfig,
    capabilities: resolveRealtimeVoiceProviderCapabilities({
      provider: resolution.provider,
      providerConfig: resolution.providerConfig,
      cfg: params.cfg,
      agentId: params.agentId,
      surface: params.surface,
      clientControl: params.clientControl,
    }),
  };
}

export async function resolveConfiguredRealtimeVoiceProviderAsync(
  params: ResolveConfiguredRealtimeVoiceProviderParams,
): Promise<ResolvedRealtimeVoiceProvider> {
  const cfgForResolve = params.cfgForResolve ?? params.cfg ?? {};
  const resolution = await resolveConfiguredCapabilityProviderAsync({
    configuredProviderId: params.configuredProviderId,
    providerConfigs: params.providerConfigs,
    cfg: params.cfg,
    cfgForResolve,
    getConfiguredProvider: (providerId) =>
      params.providers?.find((entry) => entry.id === providerId) ??
      getRealtimeVoiceProvider(providerId, params.cfg),
    listProviders: () =>
      params.providers ??
      listRealtimeVoiceProviders(params.cfg, Object.keys(params.providerConfigs ?? {})),
    isProviderAvailable: params.isProviderAvailable
      ? ({ provider }) => params.isProviderAvailable?.(provider) === true
      : undefined,
    resolveProviderConfig: async ({ provider, cfg, rawConfig }) => {
      // Provider config resolution should see the default model as if it came
      // from config, while explicit provider config still wins.
      const defaultModel =
        params.defaultModel ?? (params.useProviderDefaultModel ? provider.defaultModel : undefined);
      const rawConfigWithModel =
        defaultModel && rawConfig.model === undefined
          ? { ...rawConfig, model: defaultModel }
          : rawConfig;
      const rawConfigWithOverrides = {
        ...rawConfigWithModel,
        ...params.providerConfigOverrides,
      };
      // Per-call overrides are applied before provider normalization so provider
      // implementations can validate and coerce them consistently.
      return (
        (provider.resolveConfigAsync
          ? await provider.resolveConfigAsync({
              cfg,
              rawConfig: rawConfigWithOverrides,
              agentId: params.agentId,
              surface: params.surface,
              autoRespondToAudio: params.autoRespondToAudio,
              requiredCapabilities: params.requiredCapabilities,
            })
          : provider.resolveConfig?.({
              cfg,
              rawConfig: rawConfigWithOverrides,
              agentId: params.agentId,
              surface: params.surface,
              autoRespondToAudio: params.autoRespondToAudio,
              requiredCapabilities: params.requiredCapabilities,
            })) ?? rawConfigWithOverrides
      );
    },
    isProviderConfigured: ({ provider, cfg, providerConfig }) =>
      isRealtimeVoiceProviderConfiguredAsync({
        provider,
        cfg,
        providerConfig,
        agentId: params.agentId,
        surface: params.surface,
      }),
  });

  if (!resolution.ok && resolution.code === "missing-configured-provider") {
    throw new Error(
      `Realtime voice provider "${resolution.configuredProviderId}" is not registered`,
    );
  }
  if (!resolution.ok && resolution.code === "no-registered-provider") {
    throw new Error(params.noRegisteredProviderMessage ?? "No realtime voice provider registered");
  }
  if (!resolution.ok && resolution.code === "provider-unavailable" && resolution.provider) {
    params.assertProviderAvailable?.(resolution.provider);
    throw new Error(`Realtime voice provider "${resolution.provider.id}" is unavailable`);
  }
  if (!resolution.ok) {
    throw new Error(`Realtime voice provider "${resolution.provider?.id}" is not configured`);
  }

  return {
    provider: resolution.provider,
    providerConfig: resolution.providerConfig,
    capabilities: await resolveRealtimeVoiceProviderCapabilitiesAsync({
      provider: resolution.provider,
      providerConfig: resolution.providerConfig,
      cfg: params.cfg,
      agentId: params.agentId,
      surface: params.surface,
      clientControl: params.clientControl,
    }),
  };
}
