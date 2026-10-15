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
  type ResolvedConfiguredProvider,
} from "../plugin-sdk/provider-selection-runtime.js";
import { warnPluginSdkDeprecation } from "../plugins/sdk-deprecation.js";
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

type RealtimeVoiceProviderContext = {
  provider: RealtimeVoiceProviderPlugin;
  providerConfig: RealtimeVoiceProviderConfig;
  cfg?: OpenClawConfig;
  /** Host-selected agent scope for provider capability evaluation. */
  agentId?: string;
  surface?: RealtimeVoiceProviderResolveConfigContext["surface"];
};

type RealtimeVoiceCapabilitiesContext = RealtimeVoiceProviderContext & {
  /** Effective per-session model after request overrides. */
  model?: string;
  clientControl?: RealtimeVoiceBrowserSessionCreateRequest["clientControl"];
};

function resolveRealtimeVoiceProviderCapabilities(
  params: RealtimeVoiceCapabilitiesContext,
): InternalRealtimeVoiceProviderCapabilities | undefined {
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

function isRealtimeVoiceProviderConfigured(params: RealtimeVoiceProviderContext): boolean {
  const internalConfigured =
    params.surface === "browser-session"
      ? readInternalRealtimeVoiceProviderApi(params.provider)?.isBrowserSessionConfigured?.({
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

export async function resolveRealtimeVoiceProviderCapabilitiesAsync(
  params: RealtimeVoiceCapabilitiesContext,
): Promise<InternalRealtimeVoiceProviderCapabilities | undefined> {
  const internal = readInternalRealtimeVoiceProviderApi(params.provider);
  const context = {
    cfg: params.cfg,
    providerConfig: params.providerConfig,
    agentId: params.agentId,
    model: params.model,
    ...(params.clientControl ? { clientControl: params.clientControl } : {}),
  };
  let capabilities: InternalRealtimeVoiceProviderCapabilities | undefined;
  if (params.surface === "browser-session" && internal?.resolveBrowserSessionCapabilitiesAsync) {
    capabilities = await internal.resolveBrowserSessionCapabilitiesAsync(context);
  } else {
    if (params.surface === "browser-session" && internal?.resolveBrowserSessionCapabilities) {
      warnPluginSdkDeprecation({
        family: "provider-sync-configuration",
        method: "InternalRealtimeVoiceProviderApi.resolveBrowserSessionCapabilities",
        replacement: "resolveBrowserSessionCapabilitiesAsync",
      });
    }
    capabilities = resolveRealtimeVoiceProviderCapabilities(params);
  }

  return capabilities || params.provider.capabilities;
}

export async function isRealtimeVoiceProviderConfiguredAsync(
  params: RealtimeVoiceProviderContext,
): Promise<boolean> {
  const internal = readInternalRealtimeVoiceProviderApi(params.provider);
  const context = {
    cfg: params.cfg,
    providerConfig: params.providerConfig,
    agentId: params.agentId,
  };
  let configured: boolean | undefined;
  if (params.surface === "browser-session") {
    if (internal?.isBrowserSessionConfiguredAsync) {
      configured = await internal.isBrowserSessionConfiguredAsync(context);
    } else if (internal?.isBrowserSessionConfigured) {
      warnPluginSdkDeprecation({
        family: "provider-sync-configuration",
        method: "InternalRealtimeVoiceProviderApi.isBrowserSessionConfigured",
        replacement: "isBrowserSessionConfiguredAsync",
      });
      configured = internal.isBrowserSessionConfigured(context);
    }
  } else if (params.surface === "gateway-relay") {
    if (internal?.isGatewayRelayConfiguredAsync) {
      configured = await internal.isGatewayRelayConfiguredAsync(context);
    } else if (internal?.isGatewayRelayConfigured) {
      warnPluginSdkDeprecation({
        family: "provider-sync-configuration",
        method: "InternalRealtimeVoiceProviderApi.isGatewayRelayConfigured",
        replacement: "isGatewayRelayConfiguredAsync",
      });
      configured = internal.isGatewayRelayConfigured(context);
    }
  }
  if (configured !== undefined) {
    return configured;
  }
  if (!params.provider.isConfiguredAsync) {
    warnPluginSdkDeprecation({
      family: "provider-sync-configuration",
      method: "RealtimeVoiceProviderPlugin.isConfigured",
      replacement: "isConfiguredAsync",
    });
  }
  return params.provider.isConfiguredAsync
    ? await params.provider.isConfiguredAsync(context)
    : (params.provider.isConfigured?.(context) ?? false);
}

function prepareRealtimeVoiceProviderSelection(
  params: ResolveConfiguredRealtimeVoiceProviderParams,
) {
  return {
    configuredProviderId: params.configuredProviderId,
    providerConfigs: params.providerConfigs,
    cfg: params.cfg,
    cfgForResolve: params.cfgForResolve ?? params.cfg ?? {},
    getConfiguredProvider: (providerId: string | undefined) =>
      params.providers?.find((entry) => entry.id === providerId) ??
      getRealtimeVoiceProvider(providerId, params.cfg),
    listProviders: () =>
      params.providers ??
      listRealtimeVoiceProviders(params.cfg, Object.keys(params.providerConfigs ?? {})),
    isProviderAvailable: params.isProviderAvailable
      ? ({ provider }: { provider: RealtimeVoiceProviderPlugin }) =>
          params.isProviderAvailable?.(provider) === true
      : undefined,
  };
}

function prepareRealtimeVoiceProviderConfig(
  params: ResolveConfiguredRealtimeVoiceProviderParams,
  provider: RealtimeVoiceProviderPlugin,
  cfg: OpenClawConfig,
  rawConfig: RealtimeVoiceProviderConfig,
): RealtimeVoiceProviderResolveConfigContext {
  // Apply defaults and per-call overrides before provider normalization.
  const defaultModel =
    params.defaultModel ?? (params.useProviderDefaultModel ? provider.defaultModel : undefined);
  return {
    cfg,
    rawConfig: {
      ...(defaultModel && rawConfig.model === undefined
        ? { ...rawConfig, model: defaultModel }
        : rawConfig),
      ...params.providerConfigOverrides,
    },
    agentId: params.agentId,
    surface: params.surface,
    autoRespondToAudio: params.autoRespondToAudio,
    requiredCapabilities: params.requiredCapabilities,
  };
}

function requireRealtimeVoiceProvider(
  resolution: ResolvedConfiguredProvider<RealtimeVoiceProviderPlugin, RealtimeVoiceProviderConfig>,
  params: ResolveConfiguredRealtimeVoiceProviderParams,
) {
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
  return resolution;
}

/** @deprecated Use resolveConfiguredRealtimeVoiceProviderAsync for stored-credential providers. Final compatibility day: 2026-12-31. */
export function resolveConfiguredRealtimeVoiceProvider(
  params: ResolveConfiguredRealtimeVoiceProviderParams,
): ResolvedRealtimeVoiceProvider {
  warnPluginSdkDeprecation({
    family: "provider-selection",
    method: "resolveConfiguredRealtimeVoiceProvider",
    replacement: "await resolveConfiguredRealtimeVoiceProviderAsync()",
  });
  const resolution = requireRealtimeVoiceProvider(
    resolveConfiguredCapabilityProvider({
      ...prepareRealtimeVoiceProviderSelection(params),
      resolveProviderConfig: ({ provider, cfg, rawConfig }) => {
        const context = prepareRealtimeVoiceProviderConfig(params, provider, cfg, rawConfig);
        return provider.resolveConfig?.(context) ?? context.rawConfig;
      },
      isProviderConfigured: ({ provider, cfg, providerConfig }) =>
        isRealtimeVoiceProviderConfigured({
          provider,
          cfg,
          providerConfig,
          agentId: params.agentId,
          surface: params.surface,
        }),
    }),
    params,
  );
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
  const resolution = requireRealtimeVoiceProvider(
    await resolveConfiguredCapabilityProviderAsync({
      ...prepareRealtimeVoiceProviderSelection(params),
      resolveProviderConfig: async ({ provider, cfg, rawConfig }) => {
        const context = prepareRealtimeVoiceProviderConfig(params, provider, cfg, rawConfig);
        if (!provider.resolveConfigAsync && provider.resolveConfig) {
          warnPluginSdkDeprecation({
            family: "provider-sync-configuration",
            method: "RealtimeVoiceProviderPlugin.resolveConfig",
            replacement: "resolveConfigAsync",
          });
        }
        return (
          (provider.resolveConfigAsync
            ? await provider.resolveConfigAsync(context)
            : provider.resolveConfig?.(context)) ?? context.rawConfig
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
    }),
    params,
  );

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
