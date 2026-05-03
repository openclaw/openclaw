import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { getCurrentPluginMetadataSnapshot } from "./current-plugin-metadata-snapshot.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import type { PluginManifestModelIdNormalizationProvider } from "./manifest.js";
import {
  loadPluginMetadataSnapshot,
  type PluginMetadataSnapshot,
} from "./plugin-metadata-snapshot.js";

function collectManifestModelIdNormalizationPolicies(
  plugins: readonly Pick<PluginManifestRecord, "modelIdNormalization">[],
): Map<string, PluginManifestModelIdNormalizationProvider> {
  const policies = new Map<string, PluginManifestModelIdNormalizationProvider>();
  for (const plugin of plugins) {
    for (const [provider, policy] of Object.entries(plugin.modelIdNormalization?.providers ?? {})) {
      policies.set(normalizeLowercaseStringOrEmpty(provider), policy);
    }
  }
  return policies;
}

type ManifestModelIdNormalizationPolicyCache = {
  configFingerprint: string;
  policies: Map<string, PluginManifestModelIdNormalizationProvider>;
};

let cachedPolicies: ManifestModelIdNormalizationPolicyCache | undefined;

function resolveMetadataSnapshotForPolicies(): {
  snapshot: PluginMetadataSnapshot;
  cacheable: boolean;
} {
  const current = getCurrentPluginMetadataSnapshot({ env: process.env });
  if (current) {
    return { snapshot: current, cacheable: true };
  }
  return {
    snapshot: loadPluginMetadataSnapshot({ config: {}, env: process.env }),
    cacheable: false,
  };
}

function loadManifestModelIdNormalizationPolicies(): Map<
  string,
  PluginManifestModelIdNormalizationProvider
> {
  const { snapshot, cacheable } = resolveMetadataSnapshotForPolicies();
  const configFingerprint = snapshot.configFingerprint;
  if (cacheable && configFingerprint && cachedPolicies?.configFingerprint === configFingerprint) {
    return cachedPolicies.policies;
  }
  const policies = collectManifestModelIdNormalizationPolicies(snapshot.plugins);
  if (cacheable && configFingerprint) {
    cachedPolicies = { configFingerprint, policies };
  }
  return policies;
}

function resolveManifestModelIdNormalizationPolicy(
  provider: string,
): PluginManifestModelIdNormalizationProvider | undefined {
  const providerId = normalizeLowercaseStringOrEmpty(provider);
  return loadManifestModelIdNormalizationPolicies().get(providerId);
}

function hasProviderPrefix(modelId: string): boolean {
  return modelId.includes("/");
}

function formatPrefixedModelId(prefix: string, modelId: string): string {
  return `${prefix.replace(/\/+$/u, "")}/${modelId.replace(/^\/+/u, "")}`;
}

export function normalizeProviderModelIdWithManifest(params: {
  provider: string;
  context: {
    provider: string;
    modelId: string;
  };
}): string | undefined {
  const policy = resolveManifestModelIdNormalizationPolicy(params.provider);
  if (!policy) {
    return undefined;
  }

  let modelId = params.context.modelId.trim();
  if (!modelId) {
    return modelId;
  }

  for (const prefix of policy.stripPrefixes ?? []) {
    const normalizedPrefix = normalizeLowercaseStringOrEmpty(prefix);
    if (normalizedPrefix && normalizeLowercaseStringOrEmpty(modelId).startsWith(normalizedPrefix)) {
      modelId = modelId.slice(prefix.length);
      break;
    }
  }

  modelId = policy.aliases?.[normalizeLowercaseStringOrEmpty(modelId)] ?? modelId;

  if (!hasProviderPrefix(modelId)) {
    for (const rule of policy.prefixWhenBareAfterAliasStartsWith ?? []) {
      if (normalizeLowercaseStringOrEmpty(modelId).startsWith(rule.modelPrefix.toLowerCase())) {
        return formatPrefixedModelId(rule.prefix, modelId);
      }
    }
    if (policy.prefixWhenBare) {
      return formatPrefixedModelId(policy.prefixWhenBare, modelId);
    }
  }

  return modelId;
}
