import { normalizeModelPricingProvider } from "@openclaw/model-catalog-core/model-catalog-pricing";
import { normalizeModelCatalogProviderId } from "@openclaw/model-catalog-core/model-catalog-refs";
import { normalizeOptionalString } from "../../packages/normalization-core/src/string-coerce.js";
import {
  normalizeOptionalTrimmedStringList,
  normalizeTrimmedStringList,
} from "../../packages/normalization-core/src/string-normalization.js";
import { ENV_SECRET_REF_ID_RE } from "../config/types.secrets.js";
import { isRecord } from "../utils.js";
import {
  normalizeManifestObjectList,
  normalizeManifestStringRecord,
  normalizeNamedMetadataRecord,
  omitUndefinedManifestFields,
  optionalManifestFields,
} from "./manifest-capability-normalizers.js";
import type {
  PluginManifestModelIdNormalization,
  PluginManifestModelIdNormalizationProvider,
  PluginManifestModelIdPrefixRule,
  PluginManifestModelPricing,
  PluginManifestModelSupport,
  PluginManifestProviderEndpoint,
  PluginManifestProviderRequest,
  PluginManifestSecretProviderIntegration,
} from "./manifest-types.js";
import { normalizeManifestProviderRequestProvider } from "./plugin-provider-request-policy.js";

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

  return optionalManifestFields({
    modelPrefixes: normalizeOptionalTrimmedStringList(value.modelPrefixes),
    modelPatterns: normalizeOptionalTrimmedStringList(value.modelPatterns),
  });
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
  return optionalManifestFields({
    aliases: Object.keys(aliases).length > 0 ? aliases : undefined,
    stripPrefixes: normalizeOptionalTrimmedStringList(value.stripPrefixes),
    prefixWhenBare: normalizeOptionalString(value.prefixWhenBare),
    prefixWhenBareAfterAliasStartsWith: normalizeManifestModelIdPrefixRules(
      value.prefixWhenBareAfterAliasStartsWith,
    ),
  });
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
    const hosts = normalizeOptionalTrimmedStringList(rawEndpoint.hosts)?.map((host) =>
      host.toLowerCase(),
    );
    const hostSuffixes = normalizeOptionalTrimmedStringList(rawEndpoint.hostSuffixes)?.map((host) =>
      host.toLowerCase(),
    );
    const baseUrls = normalizeOptionalTrimmedStringList(rawEndpoint.baseUrls);
    if (!hosts && !hostSuffixes && !baseUrls) {
      return undefined;
    }
    return omitUndefinedManifestFields({
      endpointClass,
      hosts,
      hostSuffixes,
      baseUrls,
      googleVertexRegion: normalizeOptionalString(rawEndpoint.googleVertexRegion),
      googleVertexRegionHostSuffix: normalizeOptionalString(
        rawEndpoint.googleVertexRegionHostSuffix,
      )?.toLowerCase(),
    });
  });
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
    const passEnv = normalizeTrimmedStringList(rawIntegration.passEnv)
      .filter((entry) => ENV_SECRET_REF_ID_RE.test(entry))
      .slice(0, MAX_SECRET_PROVIDER_EXEC_PASS_ENV);
    return omitUndefinedManifestFields<PluginManifestSecretProviderIntegration>({
      providerAlias: normalizeOptionalString(rawIntegration.providerAlias),
      displayName: normalizeOptionalString(rawIntegration.displayName),
      description: normalizeOptionalString(rawIntegration.description),
      source: "exec",
      command,
      args: args.length > 0 ? args : undefined,
      timeoutMs: normalizeManifestPositiveInteger(
        rawIntegration.timeoutMs,
        MAX_SECRET_PROVIDER_EXEC_TIMEOUT_MS,
      ),
      noOutputTimeoutMs: normalizeManifestPositiveInteger(
        rawIntegration.noOutputTimeoutMs,
        MAX_SECRET_PROVIDER_EXEC_TIMEOUT_MS,
      ),
      maxOutputBytes: normalizeManifestPositiveInteger(
        rawIntegration.maxOutputBytes,
        MAX_SECRET_PROVIDER_EXEC_OUTPUT_BYTES,
      ),
      jsonOnly: typeof rawIntegration.jsonOnly === "boolean" ? rawIntegration.jsonOnly : undefined,
      env: normalizeManifestStringRecord(rawIntegration.env),
      passEnv: passEnv.length > 0 ? passEnv : undefined,
    });
  });
}
