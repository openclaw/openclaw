// Resolves model suppression metadata declared by plugin manifests.
import { buildModelCatalogMergeKey } from "@openclaw/model-catalog-core/model-catalog-refs";
import { findNormalizedProviderValue } from "@openclaw/model-catalog-core/provider-id";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  planManifestModelCatalogSuppressions,
  type ManifestModelCatalogSuppressionEntry,
} from "../model-catalog/index.js";
import {
  isManifestPluginAvailableForControlPlane,
  loadManifestMetadataSnapshot,
} from "./manifest-contract-eligibility.js";

function listManifestModelCatalogSuppressions(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
}): readonly ManifestModelCatalogSuppressionEntry[] {
  const snapshot = loadManifestMetadataSnapshot({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
  });
  const registry = {
    diagnostics: snapshot.diagnostics,
    plugins: snapshot.plugins.filter((plugin) =>
      isManifestPluginAvailableForControlPlane({
        snapshot,
        plugin,
        config: params.config,
      }),
    ),
  };
  const planned = planManifestModelCatalogSuppressions({ registry });
  return planned.suppressions;
}

function buildManifestSuppressionError(params: {
  provider: string;
  modelId: string;
  reason?: string;
}): string {
  const ref = `${params.provider}/${params.modelId}`;
  return params.reason ? `Unknown model: ${ref}. ${params.reason}` : `Unknown model: ${ref}.`;
}

function normalizeBaseUrlHost(baseUrl: string | null | undefined): string {
  const trimmed = baseUrl?.trim();
  if (!trimmed) {
    return "";
  }
  try {
    return normalizeSuppressionHost(new URL(trimmed).hostname);
  } catch {
    return "";
  }
}

function normalizeSuppressionHost(host: string): string {
  return normalizeLowercaseStringOrEmpty(host).replace(/\.+$/, "");
}

function resolveConfiguredProviderValue(params: {
  provider: string;
  config?: OpenClawConfig;
}): { api?: string; auth?: string; baseUrl?: string } | undefined {
  const providers = params.config?.models?.providers;
  if (!providers) {
    return undefined;
  }
  for (const [providerId, entry] of Object.entries(providers)) {
    if (normalizeLowercaseStringOrEmpty(providerId) !== params.provider) {
      continue;
    }
    return {
      api: normalizeLowercaseStringOrEmpty(entry?.api),
      auth: normalizeLowercaseStringOrEmpty(entry?.auth),
      baseUrl: typeof entry?.baseUrl === "string" ? entry.baseUrl : undefined,
    };
  }
  return undefined;
}

function resolveConfiguredAuthProfileMode(params: {
  provider: string;
  config?: OpenClawConfig;
}): string {
  const auth = params.config?.auth;
  const profiles = auth?.profiles;
  if (!profiles) {
    return "";
  }
  const orderedProfileIds = findNormalizedProviderValue(auth?.order, params.provider) ?? [];
  for (const profileId of orderedProfileIds) {
    const profile = profiles[profileId];
    if (normalizeLowercaseStringOrEmpty(profile?.provider) !== params.provider) {
      continue;
    }
    const mode = normalizeLowercaseStringOrEmpty(profile?.mode);
    if (mode) {
      return mode;
    }
  }
  const providerModes = Object.values(profiles)
    .filter((profile) => normalizeLowercaseStringOrEmpty(profile?.provider) === params.provider)
    .map((profile) => normalizeLowercaseStringOrEmpty(profile?.mode));
  if (providerModes.some((mode) => mode === "oauth" || mode === "token")) {
    return "oauth";
  }
  if (providerModes.includes("api_key")) {
    return "api_key";
  }
  if (providerModes.includes("aws-sdk")) {
    return "aws-sdk";
  }
  return "";
}

function isOpenAINativeApiDefault(params: {
  provider: string;
  api?: string | null;
  configuredProvider?: { api?: string; auth?: string; baseUrl?: string };
  configuredAuthProfileMode?: string;
}): boolean {
  if (params.provider !== "openai") {
    return false;
  }
  const explicitApi = normalizeLowercaseStringOrEmpty(params.api);
  if (explicitApi === "openai-responses" || explicitApi === "openai-completions") {
    return true;
  }
  if (!params.configuredProvider) {
    return params.configuredAuthProfileMode === "api_key";
  }
  if (normalizeBaseUrlHost(params.configuredProvider.baseUrl)) {
    return false;
  }
  const api = normalizeLowercaseStringOrEmpty(params.configuredProvider.api);
  if (api === "openai-responses" || api === "openai-completions") {
    return true;
  }
  if (!api && params.configuredAuthProfileMode === "api_key") {
    return true;
  }
  return !api && normalizeLowercaseStringOrEmpty(params.configuredProvider.auth) === "api-key";
}

function resolveEffectiveProviderApi(params: {
  provider: string;
  api?: string | null;
  configuredProvider?: { api?: string; auth?: string; baseUrl?: string };
  configuredAuthProfileMode?: string;
}): string {
  const explicitApi = normalizeLowercaseStringOrEmpty(params.api);
  if (explicitApi) {
    return explicitApi;
  }
  const configuredApi = normalizeLowercaseStringOrEmpty(params.configuredProvider?.api);
  if (configuredApi) {
    return configuredApi;
  }
  // OpenAI API-key auth without a custom base URL uses the native Responses API.
  if (isOpenAINativeApiDefault(params)) {
    return "openai-responses";
  }
  return params.configuredProvider ? "" : params.provider;
}

function resolveEffectiveBaseUrl(params: {
  provider: string;
  api?: string | null;
  baseUrl?: string | null;
  configuredProvider?: { api?: string; auth?: string; baseUrl?: string };
  configuredAuthProfileMode?: string;
}): string | null | undefined {
  const explicitBaseUrl = params.baseUrl ?? params.configuredProvider?.baseUrl;
  if (explicitBaseUrl) {
    return explicitBaseUrl;
  }
  return isOpenAINativeApiDefault(params) ? "https://api.openai.com" : explicitBaseUrl;
}

export function manifestSuppressionMatchesConditions(params: {
  suppression: ManifestModelCatalogSuppressionEntry;
  provider: string;
  api?: string | null;
  baseUrl?: string | null;
  config?: OpenClawConfig;
}): boolean {
  const when = params.suppression.when;
  if (!when) {
    return true;
  }
  const configuredProvider = resolveConfiguredProviderValue({
    provider: params.provider,
    config: params.config,
  });
  const configuredAuthProfileMode = resolveConfiguredAuthProfileMode({
    provider: params.provider,
    config: params.config,
  });
  if (when.providerConfigApiIn?.length) {
    const allowedApis = new Set(when.providerConfigApiIn.map(normalizeLowercaseStringOrEmpty));
    const effectiveApi = resolveEffectiveProviderApi({
      provider: params.provider,
      api: params.api,
      configuredProvider,
      configuredAuthProfileMode,
    });
    if (!effectiveApi || !allowedApis.has(effectiveApi)) {
      return false;
    }
  }
  if (when.baseUrlHosts?.length) {
    const baseUrlHost = normalizeBaseUrlHost(
      resolveEffectiveBaseUrl({
        provider: params.provider,
        api: params.api,
        baseUrl: params.baseUrl,
        configuredProvider,
        configuredAuthProfileMode,
      }),
    );
    if (!baseUrlHost) {
      return false;
    }
    const allowedHosts = new Set(when.baseUrlHosts.map(normalizeSuppressionHost));
    if (!allowedHosts.has(baseUrlHost)) {
      return false;
    }
  }
  return true;
}

export function buildManifestBuiltInModelSuppressionResolver(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}) {
  const suppressions = listManifestModelCatalogSuppressions({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env ?? process.env,
  });

  return (input: {
    provider?: string | null;
    id?: string | null;
    api?: string | null;
    baseUrl?: string | null;
    unconditionalOnly?: boolean;
  }) => {
    const provider = normalizeLowercaseStringOrEmpty(input.provider);
    const modelId = normalizeLowercaseStringOrEmpty(input.id);
    if (!provider || !modelId) {
      return undefined;
    }
    const mergeKey = buildModelCatalogMergeKey(provider, modelId);
    const suppression = suppressions.find(
      (entry) =>
        entry.mergeKey === mergeKey &&
        (!input.unconditionalOnly || !entry.when) &&
        manifestSuppressionMatchesConditions({
          suppression: entry,
          provider,
          api: input.api,
          baseUrl: input.baseUrl,
          config: params.config,
        }),
    );
    if (!suppression) {
      return undefined;
    }
    return {
      suppress: true,
      errorMessage: buildManifestSuppressionError({
        provider,
        modelId,
        reason: suppression.reason,
      }),
    };
  };
}

/**
 * Resolves whether a built-in model should be suppressed based on manifest declarations.
 *
 * Note: This function instantiates a fresh resolver on every call, which incurs a full
 * filesystem scan of the manifest registry. For hot paths (like building the model catalog),
 * instantiate and reuse `buildManifestBuiltInModelSuppressionResolver` instead.
 */
export function resolveManifestBuiltInModelSuppression(params: {
  provider?: string | null;
  id?: string | null;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  baseUrl?: string | null;
  api?: string | null;
  unconditionalOnly?: boolean;
}) {
  const resolver = buildManifestBuiltInModelSuppressionResolver({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
  });
  return resolver({
    provider: params.provider,
    id: params.id,
    api: params.api,
    baseUrl: params.baseUrl,
    unconditionalOnly: params.unconditionalOnly,
  });
}
