/** Generic adapter for provider-owned model route public artifacts. */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type {
  ModelApi,
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveDirectBundledProviderPolicySurface,
  type BundledProviderPolicySurface,
  type ProviderModelRouteResolution,
  type ProviderModelRouteSource,
} from "./provider-policy-surface.js";

type ProviderModelRouteObservation = ProviderModelRouteSource & {
  modelId?: string;
};

export type ProviderModelRoutesResolver = (
  observed?: ProviderModelRouteObservation,
) => ProviderModelRouteResolution | null;

function resolveConfiguredProvider(params: {
  config?: OpenClawConfig;
  provider: string;
}): ModelProviderConfig | undefined {
  const exact = params.config?.models?.providers?.[params.provider];
  if (exact) {
    return exact;
  }
  for (const [providerId, providerConfig] of Object.entries(
    params.config?.models?.providers ?? {},
  )) {
    if (normalizeProviderId(providerId) === params.provider) {
      return providerConfig;
    }
  }
  return undefined;
}

function normalizeModelId(provider: string, modelId: string | undefined): string | undefined {
  const trimmed = modelId?.trim();
  if (!trimmed) {
    return undefined;
  }
  const slashIndex = trimmed.indexOf("/");
  if (slashIndex <= 0) {
    return trimmed;
  }
  return normalizeProviderId(trimmed.slice(0, slashIndex)) === provider
    ? trimmed.slice(slashIndex + 1).trim() || undefined
    : trimmed;
}

function indexConfiguredModels(
  provider: string,
  providerConfig: ModelProviderConfig | undefined,
): ReadonlyMap<string, ModelDefinitionConfig> {
  const models = new Map<string, ModelDefinitionConfig>();
  for (const model of providerConfig?.models ?? []) {
    const modelId = normalizeModelId(provider, model.id);
    if (modelId && !models.has(modelId)) {
      models.set(modelId, model);
    }
  }
  return models;
}

/**
 * Captures the process-stable provider artifact and one config snapshot for
 * repeated row resolution. Environment/config are snapshot inputs; only each
 * observed model row varies between calls.
 */
export function createProviderModelRoutesResolver(params: {
  provider: string;
  config?: OpenClawConfig;
  environment?: { baseUrl?: unknown };
  surface?: BundledProviderPolicySurface | null;
}): ProviderModelRoutesResolver {
  const provider = normalizeProviderId(params.provider);
  if (!provider) {
    return () => null;
  }
  const surface =
    params.surface === undefined
      ? resolveDirectBundledProviderPolicySurface(provider)
      : params.surface;
  const resolveModelRoutes = surface?.resolveModelRoutes;
  const providerConfig = resolveConfiguredProvider({ config: params.config, provider });
  const configuredModels = indexConfiguredModels(provider, providerConfig);

  return (observed) => {
    if (!provider || !resolveModelRoutes) {
      return null;
    }
    const modelId = normalizeModelId(provider, observed?.modelId);
    const configuredModel = modelId ? configuredModels.get(modelId) : undefined;
    return (
      resolveModelRoutes({
        provider,
        ...(modelId ? { modelId } : {}),
        ...(configuredModel
          ? {
              configuredModel: {
                api: configuredModel.api,
                baseUrl: configuredModel.baseUrl,
              },
            }
          : {}),
        ...(providerConfig
          ? {
              configuredProvider: {
                api: providerConfig.api,
                baseUrl: providerConfig.baseUrl,
              },
            }
          : {}),
        ...(params.environment ? { environment: params.environment } : {}),
        ...(observed ? { observed: { api: observed.api, baseUrl: observed.baseUrl } } : {}),
      }) ?? null
    );
  };
}

/** Resolves one model route through its bundled provider public artifact. */
export function resolveProviderModelRoutes(params: {
  provider: string;
  modelId?: string;
  api?: ModelApi | null;
  baseUrl?: unknown;
  config?: OpenClawConfig;
  environment?: { baseUrl?: unknown };
  surface?: BundledProviderPolicySurface | null;
}): ProviderModelRouteResolution | null {
  const resolveRoutes = createProviderModelRoutesResolver(params);
  return resolveRoutes({
    modelId: params.modelId,
    api: params.api,
    baseUrl: params.baseUrl,
  });
}
