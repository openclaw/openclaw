import { normalizeModelPricingProvider } from "@openclaw/model-catalog-core/model-catalog-pricing";
import { normalizeModelCatalogProviderId } from "@openclaw/model-catalog-core/model-catalog-refs";
import { normalizeOptionalString } from "../../packages/normalization-core/src/string-coerce.js";
import { normalizeTrimmedStringList } from "../../packages/normalization-core/src/string-normalization.js";
import { ENV_SECRET_REF_ID_RE } from "../config/types.secrets.js";
import { isRecord } from "../utils.js";
import {
  normalizeManifestObjectList,
  normalizeManifestStringRecord,
  normalizeNamedMetadataRecord,
} from "./manifest-capability-normalizers.js";
import type {
  PluginManifestModelIdNormalization,
  PluginManifestModelIdNormalizationProvider,
  PluginManifestModelIdPrefixRule,
  PluginManifestModelPricing,
  PluginManifestModelSupport,
  PluginManifestProviderEndpoint,
  PluginManifestProviderRequest,
  PluginManifestProviderRequestProvider,
  PluginManifestSecretProviderIntegration,
} from "./manifest-types.js";

const MAX_SECRET_PROVIDER_EXEC_ARGS = 128;
const MAX_SECRET_PROVIDER_EXEC_ARG_BYTES = 1024;
const MAX_SECRET_PROVIDER_EXEC_TIMEOUT_MS = 120_000;
const MAX_SECRET_PROVIDER_EXEC_OUTPUT_BYTES = 20 * 1024 * 1024;
const MAX_SECRET_PROVIDER_EXEC_PASS_ENV = 128;
const SECRET_PROVIDER_NODE_COMMAND_PLACEHOLDER = "${node}";

export function normalizeManifestModelSupport(
  value: unknown,
): PluginManifestModelSupport | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const modelPrefixes = normalizeTrimmedStringList(value.modelPrefixes);
  const modelPatterns = normalizeTrimmedStringList(value.modelPatterns);
  const modelSupport = {
    ...(modelPrefixes.length > 0 ? { modelPrefixes } : {}),
    ...(modelPatterns.length > 0 ? { modelPatterns } : {}),
  } satisfies PluginManifestModelSupport;

  return Object.keys(modelSupport).length > 0 ? modelSupport : undefined;
}

function normalizeOwnedProviderMap<T>(
  value: unknown,
  ownedProvidersRaw: ReadonlySet<string>,
  normalizePolicy: (value: unknown) => T | undefined,
): Record<string, T> | undefined {
  if (!isRecord(value) || !isRecord(value.providers)) {
    return undefined;
  }
  const ownedProviders = new Set(
    [...ownedProvidersRaw]
      .map((provider) => normalizeModelCatalogProviderId(provider))
      .filter(Boolean),
  );
  const providers: Record<string, T> = {};
  for (const [rawProviderId, rawPolicy] of Object.entries(value.providers)) {
    const providerId = normalizeModelCatalogProviderId(rawProviderId);
    const policy = providerId && ownedProviders.has(providerId) ? normalizePolicy(rawPolicy) : null;
    if (providerId && policy) {
      providers[providerId] = policy;
    }
  }
  return Object.keys(providers).length > 0 ? providers : undefined;
}

export function normalizeManifestModelPricing(
  value: unknown,
  params: { ownedProviders: ReadonlySet<string> },
): PluginManifestModelPricing | undefined {
  const providers = normalizeOwnedProviderMap(
    value,
    params.ownedProviders,
    normalizeModelPricingProvider,
  );
  return providers ? { providers } : undefined;
}

function normalizeManifestModelIdPrefixRules(
  value: unknown,
): PluginManifestModelIdPrefixRule[] | undefined {
  return normalizeManifestObjectList(value, (rawRule) => {
    const modelPrefix = normalizeOptionalString(rawRule.modelPrefix);
    const prefix = normalizeOptionalString(rawRule.prefix);
    return modelPrefix && prefix ? { modelPrefix, prefix } : undefined;
  });
}

function normalizeManifestModelIdNormalizationProvider(
  value: unknown,
): PluginManifestModelIdNormalizationProvider | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const aliases: Record<string, string> = {};
  if (isRecord(value.aliases)) {
    for (const [rawAlias, rawCanonical] of Object.entries(value.aliases)) {
      const alias = normalizeModelCatalogProviderId(rawAlias);
      const canonical = normalizeOptionalString(rawCanonical);
      if (alias && canonical) {
        aliases[alias] = canonical;
      }
    }
  }
  const stripPrefixes = normalizeTrimmedStringList(value.stripPrefixes);
  const prefixWhenBare = normalizeOptionalString(value.prefixWhenBare);
  const prefixWhenBareAfterAliasStartsWith = normalizeManifestModelIdPrefixRules(
    value.prefixWhenBareAfterAliasStartsWith,
  );
  const normalization = {
    ...(Object.keys(aliases).length > 0 ? { aliases } : {}),
    ...(stripPrefixes.length > 0 ? { stripPrefixes } : {}),
    ...(prefixWhenBare ? { prefixWhenBare } : {}),
    ...(prefixWhenBareAfterAliasStartsWith ? { prefixWhenBareAfterAliasStartsWith } : {}),
  } satisfies PluginManifestModelIdNormalizationProvider;

  return Object.keys(normalization).length > 0 ? normalization : undefined;
}

export function normalizeManifestModelIdNormalization(
  value: unknown,
  params: { ownedProviders: ReadonlySet<string> },
): PluginManifestModelIdNormalization | undefined {
  const providers = normalizeOwnedProviderMap(
    value,
    params.ownedProviders,
    normalizeManifestModelIdNormalizationProvider,
  );
  return providers ? { providers } : undefined;
}

export function normalizeManifestProviderEndpoints(
  value: unknown,
): PluginManifestProviderEndpoint[] | undefined {
  return normalizeManifestObjectList(value, (rawEndpoint) => {
    const endpointClass = normalizeOptionalString(rawEndpoint.endpointClass);
    if (!endpointClass) {
      return undefined;
    }
    const hosts = normalizeTrimmedStringList(rawEndpoint.hosts).map((host) => host.toLowerCase());
    const hostSuffixes = normalizeTrimmedStringList(rawEndpoint.hostSuffixes).map((host) =>
      host.toLowerCase(),
    );
    const baseUrls = normalizeTrimmedStringList(rawEndpoint.baseUrls);
    const googleVertexRegion = normalizeOptionalString(rawEndpoint.googleVertexRegion);
    const googleVertexRegionHostSuffix = normalizeOptionalString(
      rawEndpoint.googleVertexRegionHostSuffix,
    )?.toLowerCase();
    if (hosts.length === 0 && hostSuffixes.length === 0 && baseUrls.length === 0) {
      return undefined;
    }
    return {
      endpointClass,
      ...(hosts.length > 0 ? { hosts } : {}),
      ...(hostSuffixes.length > 0 ? { hostSuffixes } : {}),
      ...(baseUrls.length > 0 ? { baseUrls } : {}),
      ...(googleVertexRegion ? { googleVertexRegion } : {}),
      ...(googleVertexRegionHostSuffix ? { googleVertexRegionHostSuffix } : {}),
    };
  });
}

function normalizeManifestProviderRequestProvider(
  value: unknown,
): PluginManifestProviderRequestProvider | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const family = normalizeOptionalString(value.family);
  const compatibilityFamily =
    normalizeOptionalString(value.compatibilityFamily) === "moonshot" ? "moonshot" : undefined;
  const supportsStreamingUsage = isRecord(value.openAICompletions)
    ? value.openAICompletions.supportsStreamingUsage
    : undefined;
  const openAICompletions =
    typeof supportsStreamingUsage === "boolean" ? { supportsStreamingUsage } : undefined;
  const providerRequest = {
    ...(family ? { family } : {}),
    ...(compatibilityFamily ? { compatibilityFamily } : {}),
    ...(openAICompletions ? { openAICompletions } : {}),
  } satisfies PluginManifestProviderRequestProvider;
  return Object.keys(providerRequest).length > 0 ? providerRequest : undefined;
}

export function normalizeManifestProviderRequest(
  value: unknown,
  params: { ownedProviders: ReadonlySet<string> },
): PluginManifestProviderRequest | undefined {
  const providers = normalizeOwnedProviderMap(
    value,
    params.ownedProviders,
    normalizeManifestProviderRequestProvider,
  );
  return providers ? { providers } : undefined;
}

function normalizeManifestPositiveInteger(value: unknown, max: number): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= max
    ? value
    : undefined;
}

export function normalizeManifestSecretProviderIntegrations(
  value: unknown,
): Record<string, PluginManifestSecretProviderIntegration> | undefined {
  return normalizeNamedMetadataRecord(value, (rawIntegration) => {
    const command = normalizeOptionalString(rawIntegration.command);
    if (rawIntegration.source !== "exec" || command !== SECRET_PROVIDER_NODE_COMMAND_PLACEHOLDER) {
      return undefined;
    }
    const providerAlias = normalizeOptionalString(rawIntegration.providerAlias);
    const displayName = normalizeOptionalString(rawIntegration.displayName);
    const description = normalizeOptionalString(rawIntegration.description);
    const args: string[] = [];
    if (Array.isArray(rawIntegration.args)) {
      for (const entry of rawIntegration.args) {
        if (typeof entry !== "string" || entry.length > MAX_SECRET_PROVIDER_EXEC_ARG_BYTES) {
          continue;
        }
        args.push(entry);
        if (args.length >= MAX_SECRET_PROVIDER_EXEC_ARGS) {
          break;
        }
      }
    }
    const timeoutMs = normalizeManifestPositiveInteger(
      rawIntegration.timeoutMs,
      MAX_SECRET_PROVIDER_EXEC_TIMEOUT_MS,
    );
    const noOutputTimeoutMs = normalizeManifestPositiveInteger(
      rawIntegration.noOutputTimeoutMs,
      MAX_SECRET_PROVIDER_EXEC_TIMEOUT_MS,
    );
    const maxOutputBytes = normalizeManifestPositiveInteger(
      rawIntegration.maxOutputBytes,
      MAX_SECRET_PROVIDER_EXEC_OUTPUT_BYTES,
    );
    const env = normalizeManifestStringRecord(rawIntegration.env);
    const passEnv = normalizeTrimmedStringList(rawIntegration.passEnv)
      .filter((entry) => ENV_SECRET_REF_ID_RE.test(entry))
      .slice(0, MAX_SECRET_PROVIDER_EXEC_PASS_ENV);
    return {
      ...(providerAlias ? { providerAlias } : {}),
      ...(displayName ? { displayName } : {}),
      ...(description ? { description } : {}),
      source: "exec",
      command,
      ...(args.length > 0 ? { args } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(noOutputTimeoutMs !== undefined ? { noOutputTimeoutMs } : {}),
      ...(maxOutputBytes !== undefined ? { maxOutputBytes } : {}),
      ...(typeof rawIntegration.jsonOnly === "boolean"
        ? { jsonOnly: rawIntegration.jsonOnly }
        : {}),
      ...(env ? { env } : {}),
      ...(passEnv.length > 0 ? { passEnv } : {}),
    };
  });
}
