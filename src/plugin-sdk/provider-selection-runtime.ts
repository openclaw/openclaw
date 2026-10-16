import { normalizeOptionalString } from "../../packages/normalization-core/src/string-coerce.js";
import { warnPluginSdkDeprecation } from "../plugins/sdk-deprecation.js";

/** Provider descriptor fields needed for explicit or automatic selection. */
export type AutoSelectableProvider = {
  /** Provider id used for explicit config lookup and selected result metadata. */
  id: string;
  /** Declared aliases, in preference order, used for automatic config defaults. */
  aliases?: readonly string[];
  /** Lower values win when no explicit provider is configured. */
  autoSelectOrder?: number;
};

/** Provider selection result before capability-specific configuration checks run. */
export type ProviderSelection<TProvider> = {
  /** Normalized explicit provider id, when the caller supplied one. */
  configuredProviderId?: string;
  /** True when an explicit provider id was configured but no provider was registered. */
  missingConfiguredProvider: boolean;
  /** Selected provider, either explicit or the first auto-selectable provider. */
  provider: TProvider | undefined;
};

/** Final provider resolution result including capability-specific config. */
export type ResolvedConfiguredProvider<TProvider, TConfig> =
  | {
      /** Provider exists and passed the capability-specific configuration check. */
      ok: true;
      /** Normalized explicit provider id, when the caller supplied one. */
      configuredProviderId?: string;
      /** Selected provider plugin/descriptor. */
      provider: TProvider;
      /** Capability-specific provider config resolved for the selected provider. */
      providerConfig: TConfig;
    }
  | {
      /** Provider selection failed before a configured provider could be used. */
      ok: false;
      /** Stable failure code for setup/runtime callers. */
      code:
        | "missing-configured-provider"
        | "no-registered-provider"
        | "provider-not-configured"
        | "provider-unavailable";
      /** Normalized explicit provider id, when the caller supplied one. */
      configuredProviderId?: string;
      /** Candidate provider that existed but failed configuration checks. */
      provider?: TProvider;
    };

/** Select an explicit provider when configured, otherwise the lowest-order auto provider. */
export function selectConfiguredOrAutoProvider<TProvider extends AutoSelectableProvider>(params: {
  /** Optional explicit provider id from config or user input. */
  configuredProviderId?: string;
  /** Lookup for an explicit provider id after normalization. */
  getConfiguredProvider: (providerId: string | undefined) => TProvider | undefined;
  /** Iterable of providers eligible for auto-selection. */
  listProviders: () => Iterable<TProvider>;
}): ProviderSelection<TProvider> {
  const configuredProviderId = normalizeOptionalString(params.configuredProviderId);
  const configuredProvider = configuredProviderId
    ? params.getConfiguredProvider(configuredProviderId)
    : undefined;

  if (configuredProviderId && !configuredProvider) {
    return {
      configuredProviderId,
      missingConfiguredProvider: true,
      provider: undefined,
    };
  }

  return {
    configuredProviderId,
    missingConfiguredProvider: false,
    provider: configuredProvider ?? selectFirstAutoProvider(params.listProviders()),
  };
}

/** Merge automatic alias defaults, canonical config, and explicit selected overrides. */
export function resolveProviderRawConfig(params: {
  /** Canonical provider id whose config overrides automatic alias defaults. */
  providerId: string;
  /** Declared aliases used only for automatic selection; earlier aliases take precedence. */
  providerAliases?: readonly string[];
  /** Optional selected/alias provider id whose config overrides canonical values. */
  configuredProviderId?: string;
  /** Provider config map keyed by canonical and configured provider ids. */
  providerConfigs?: Record<string, Record<string, unknown> | undefined>;
}): Record<string, unknown> {
  // Canonical values beat automatic alias defaults. Explicit selection retains
  // its canonical-plus-selected merge without inheriting unrelated alias config.
  const providerIds = params.configuredProviderId
    ? [params.providerId, params.configuredProviderId]
    : [...(params.providerAliases ?? []).toReversed(), params.providerId];
  return Object.fromEntries(
    providerIds.flatMap((providerId) => {
      const config = providerId ? params.providerConfigs?.[providerId] : undefined;
      return config && typeof config === "object" ? Object.entries(config) : [];
    }),
  );
}

type CapabilityProviderSelectionParams<TFullConfig, TProvider extends AutoSelectableProvider> = {
  /** Optional explicit provider id from config or user input. */
  configuredProviderId?: string;
  /** Provider config map used to merge alias defaults, canonical settings, and explicit overrides. */
  providerConfigs?: Record<string, Record<string, unknown> | undefined>;
  /** Current full config used only for configured-state checks. */
  cfg: TFullConfig | undefined;
  /** Full config passed to provider config resolution. */
  cfgForResolve: TFullConfig;
  /** Lookup for an explicit provider id after normalization. */
  getConfiguredProvider: (providerId: string | undefined) => TProvider | undefined;
  /** Iterable of providers eligible for auto-selection. */
  listProviders: () => Iterable<TProvider>;
  /** Availability gate checked before provider-specific config normalization. */
  isProviderAvailable?: (params: { provider: TProvider }) => boolean;
};

type ProviderConfigContext<TProvider, TFullConfig> = {
  provider: TProvider;
  cfg: TFullConfig;
  rawConfig: Record<string, unknown>;
};

type ProviderConfiguredContext<TProvider, TFullConfig, TConfig> = {
  provider: TProvider;
  cfg: TFullConfig | undefined;
  providerConfig: TConfig;
};

function prepareProviderCandidates<TFullConfig, TProvider extends AutoSelectableProvider>(
  params: CapabilityProviderSelectionParams<TFullConfig, TProvider>,
) {
  const configuredProviderId = normalizeOptionalString(params.configuredProviderId);
  const provider = configuredProviderId
    ? params.getConfiguredProvider(configuredProviderId)
    : undefined;
  return {
    configuredProviderId,
    providers: configuredProviderId
      ? provider
        ? [provider]
        : []
      : [...params.listProviders()].toSorted(compareProviderAutoSelectOrder),
  };
}

function providerConfigContext<TFullConfig, TProvider extends AutoSelectableProvider>(
  params: CapabilityProviderSelectionParams<TFullConfig, TProvider>,
  provider: TProvider,
  configuredProviderId: string | undefined,
): ProviderConfigContext<TProvider, TFullConfig> {
  return {
    provider,
    cfg: params.cfgForResolve,
    rawConfig: resolveProviderRawConfig({
      providerId: provider.id,
      providerAliases: provider.aliases,
      configuredProviderId,
      providerConfigs: params.providerConfigs,
    }),
  };
}

/** @deprecated Use resolveConfiguredCapabilityProviderAsync when providers resolve stored credentials. Final compatibility day: 2026-12-31. */
export function resolveConfiguredCapabilityProvider<
  TConfig,
  TFullConfig,
  TProvider extends AutoSelectableProvider,
>(
  params: CapabilityProviderSelectionParams<TFullConfig, TProvider> & {
    resolveProviderConfig: (params: ProviderConfigContext<TProvider, TFullConfig>) => TConfig;
    isProviderConfigured: (
      params: ProviderConfiguredContext<TProvider, TFullConfig, TConfig>,
    ) => boolean;
  },
): ResolvedConfiguredProvider<TProvider, TConfig> {
  warnPluginSdkDeprecation({
    family: "provider-selection",
    method: "resolveConfiguredCapabilityProvider",
    replacement: "await resolveConfiguredCapabilityProviderAsync()",
  });
  const { configuredProviderId, providers } = prepareProviderCandidates(params);
  if (providers.length === 0) {
    return {
      ok: false,
      code: configuredProviderId ? "missing-configured-provider" : "no-registered-provider",
      ...(configuredProviderId ? { configuredProviderId } : {}),
    };
  }

  let firstUnavailable: TProvider | undefined;
  let firstUnconfigured: TProvider | undefined;
  for (const provider of providers) {
    if (
      !configuredProviderId &&
      params.isProviderAvailable &&
      !params.isProviderAvailable({ provider })
    ) {
      firstUnavailable ??= provider;
      continue;
    }
    const providerConfig = params.resolveProviderConfig(
      providerConfigContext(params, provider, configuredProviderId),
    );
    if (params.isProviderConfigured({ provider, cfg: params.cfg, providerConfig })) {
      return { ok: true, configuredProviderId, provider, providerConfig };
    }
    if (configuredProviderId) {
      return { ok: false, code: "provider-not-configured", configuredProviderId, provider };
    }
    firstUnconfigured ??= provider;
  }

  return {
    ok: false,
    code:
      !firstUnconfigured && firstUnavailable ? "provider-unavailable" : "provider-not-configured",
    provider: firstUnconfigured ?? firstUnavailable,
  };
}

/** Async configuration and availability preserve provider selection order. */
export async function resolveConfiguredCapabilityProviderAsync<
  TConfig,
  TFullConfig,
  TProvider extends AutoSelectableProvider,
>(
  params: CapabilityProviderSelectionParams<TFullConfig, TProvider> & {
    resolveProviderConfig: (
      params: ProviderConfigContext<TProvider, TFullConfig>,
    ) => TConfig | Promise<TConfig>;
    isProviderConfigured: (
      params: ProviderConfiguredContext<TProvider, TFullConfig, TConfig>,
    ) => boolean | Promise<boolean>;
  },
): Promise<ResolvedConfiguredProvider<TProvider, TConfig>> {
  const { configuredProviderId, providers } = prepareProviderCandidates(params);
  if (providers.length === 0) {
    return {
      ok: false,
      code: configuredProviderId ? "missing-configured-provider" : "no-registered-provider",
      ...(configuredProviderId ? { configuredProviderId } : {}),
    };
  }

  let firstUnavailable: TProvider | undefined;
  let firstUnconfigured: TProvider | undefined;
  for (const provider of providers) {
    if (
      !configuredProviderId &&
      params.isProviderAvailable &&
      !params.isProviderAvailable({ provider })
    ) {
      firstUnavailable ??= provider;
      continue;
    }
    const providerConfig = await params.resolveProviderConfig(
      providerConfigContext(params, provider, configuredProviderId),
    );
    if (await params.isProviderConfigured({ provider, cfg: params.cfg, providerConfig })) {
      return { ok: true, configuredProviderId, provider, providerConfig };
    }
    if (configuredProviderId) {
      return { ok: false, code: "provider-not-configured", configuredProviderId, provider };
    }
    firstUnconfigured ??= provider;
  }

  return {
    ok: false,
    code:
      !firstUnconfigured && firstUnavailable ? "provider-unavailable" : "provider-not-configured",
    provider: firstUnconfigured ?? firstUnavailable,
  };
}

function compareProviderAutoSelectOrder<TProvider extends AutoSelectableProvider>(
  left: TProvider,
  right: TProvider,
): number {
  return (
    (left.autoSelectOrder ?? Number.MAX_SAFE_INTEGER) -
    (right.autoSelectOrder ?? Number.MAX_SAFE_INTEGER)
  );
}

function selectFirstAutoProvider<TProvider extends AutoSelectableProvider>(
  providers: Iterable<TProvider>,
): TProvider | undefined {
  let selected: TProvider | undefined;
  for (const provider of providers) {
    if (!selected || compareProviderAutoSelectOrder(provider, selected) < 0) {
      selected = provider;
    }
  }
  return selected;
}
