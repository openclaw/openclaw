/** Resolves provider environment variable candidates and auth evidence from core/plugin metadata. */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { resolveProviderAuthAliasMap } from "../agents/provider-auth-aliases.js";
import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { prepareBundledDiscoveryMode } from "../plugins/bundled-discovery-state.js";
import { normalizePluginsConfig } from "../plugins/config-state.js";
import { getCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import { createInstalledPluginEnabledPredicate } from "../plugins/installed-plugin-index.js";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import { getPluginCache, retainPluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import {
  isWorkspacePluginAllowedByConfig,
  normalizePluginConfigId,
} from "../plugins/plugin-config-trust.js";
import {
  loadPluginMetadataSnapshot,
  type PluginMetadataSnapshot,
} from "../plugins/plugin-metadata-snapshot.js";
import { hasKind } from "../plugins/slots.js";
import { appendUniqueEnvVarCandidates } from "../shared/env-var-candidates.js";

const CORE_PROVIDER_AUTH_ENV_VAR_CANDIDATES = {
  anthropic: ["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
  openai: ["CODEX_API_KEY", "OPENAI_API_KEY"],
  voyage: ["VOYAGE_API_KEY"],
  cerebras: ["CEREBRAS_API_KEY"],
  "anthropic-openai": ["ANTHROPIC_API_KEY"],
  "qwen-dashscope": ["DASHSCOPE_API_KEY"],
} as const;

const CORE_PROVIDER_SETUP_ENV_VAR_OVERRIDES = {
  minimax: ["MINIMAX_API_KEY"],
  "minimax-cn": ["MINIMAX_API_KEY"],
} as const;

export type ProviderEnvVarLookupParams = {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  includeUntrustedWorkspacePlugins?: boolean;
  metadataSnapshot?: PluginMetadataSnapshot;
};

/** Manifest-provided evidence that a provider auth credential exists outside config. */
export type ProviderAuthEvidence = {
  type: "local-file-with-env";
  fileEnvVar?: string;
  fallbackPaths?: readonly string[];
  requiresAnyEnv?: readonly string[];
  requiresAllEnv?: readonly string[];
  credentialMarker: string;
  source?: string;
};

/** Provider auth lookup maps resolved from plugin metadata and core fallback rules. */
export type ProviderAuthLookupMaps = {
  aliasMap: Readonly<Record<string, string>>;
  envCandidateMap: Readonly<Record<string, readonly string[]>>;
  authEvidenceMap: Readonly<Record<string, readonly ProviderAuthEvidence[]>>;
  setupProviderFallbackRefs: readonly string[];
};

function isWorkspacePluginTrustedForProviderEnvVars(
  plugin: PluginManifestRecord,
  config: OpenClawConfig | undefined,
): boolean {
  return isWorkspacePluginAllowedByConfig({
    config,
    isImplicitlyAllowed: (pluginId) =>
      hasKind(plugin.kind, "context-engine") &&
      normalizePluginConfigId(config?.plugins?.slots?.contextEngine) === pluginId,
    plugin,
  });
}

function shouldUsePluginProviderEnvVars(
  plugin: PluginManifestRecord,
  params: ProviderEnvVarLookupParams | undefined,
): boolean {
  if (plugin.origin !== "workspace" || params?.includeUntrustedWorkspacePlugins !== false) {
    return true;
  }
  // Env-var candidates are hints for lookup/scrubbing, but callers can opt into the same
  // workspace trust filter used for stronger auth evidence when probing scoped workspaces.
  return isWorkspacePluginTrustedForProviderEnvVars(plugin, params?.config);
}

function shouldUsePluginProviderAuthEvidence(
  plugin: PluginManifestRecord,
  params: ProviderEnvVarLookupParams | undefined,
): boolean {
  if (plugin.origin !== "workspace") {
    return true;
  }
  // Auth evidence can point at local credential files, so workspace plugins must be explicitly
  // trusted through config before their evidence participates in auth discovery.
  return isWorkspacePluginTrustedForProviderEnvVars(plugin, params?.config);
}

/** `target` must be prototype-less for the same reason as `appendUniqueEnvVarCandidates`. */
function appendUniqueAuthEvidence(
  target: Record<string, ProviderAuthEvidence[]>,
  providerId: string,
  evidence: readonly ProviderAuthEvidence[],
) {
  const normalizedProviderId = providerId.trim();
  if (!normalizedProviderId || evidence.length === 0) {
    return;
  }
  const bucket = (target[normalizedProviderId] ??= []);
  const seen = new Set(bucket.map((entry) => JSON.stringify(entry)));
  for (const entry of evidence) {
    const key = JSON.stringify(entry);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    bucket.push(entry);
  }
}

function appendUniqueProviderRef(target: Set<string>, providerId: string): void {
  const normalized = normalizeProviderId(providerId);
  if (normalized) {
    target.add(normalized);
  }
}

function findProviderMetadataSnapshot(
  params?: ProviderEnvVarLookupParams,
  options: { allowSynchronousPolicyRead?: boolean } = {},
): PluginMetadataSnapshot | undefined {
  if (params?.metadataSnapshot) {
    return params.metadataSnapshot;
  }
  const config = params?.config;
  const env = params?.env ?? process.env;
  const current = getCurrentPluginMetadataSnapshot({
    ...options,
    env,
    ...(params?.workspaceDir !== undefined ? { workspaceDir: params.workspaceDir } : {}),
    allowWorkspaceScopedSnapshot: true,
    ...(config ? { config } : { requireDefaultDiscoveryContext: true }),
  });
  if (current) {
    return current;
  }
  // A deferred configured lookup cannot fall through until its policy has been prepared.
  if (options.allowSynchronousPolicyRead === false) {
    return undefined;
  }
  if (config && normalizePluginsConfig(config.plugins).loadPaths.length === 0) {
    // Configs without explicit load paths can reuse the process-scoped snapshot; plugin-scoped
    // configs need fresh metadata so workspace allow/deny decisions are not bypassed.
    const unscopedCurrent = getCurrentPluginMetadataSnapshot({
      env,
      ...(params?.workspaceDir !== undefined ? { workspaceDir: params.workspaceDir } : {}),
      allowWorkspaceScopedSnapshot: true,
      requireDefaultDiscoveryContext: true,
    });
    if (unscopedCurrent) {
      return unscopedCurrent;
    }
  }
  return undefined;
}

function resolveProviderMetadataSnapshot(
  params?: ProviderEnvVarLookupParams,
): PluginMetadataSnapshot {
  return (
    findProviderMetadataSnapshot(params) ??
    loadPluginMetadataSnapshot({
      config: params?.config ?? {},
      workspaceDir: params?.workspaceDir,
      env: params?.env ?? process.env,
      preferPersisted: false,
    })
  );
}

function resolveManifestProviderUsageAuthEnvVarNames(
  params?: ProviderEnvVarLookupParams,
): string[] {
  const snapshot = resolveProviderMetadataSnapshot(params);
  return uniqueStrings(
    snapshot.plugins
      .filter((plugin) => shouldUsePluginProviderEnvVars(plugin, params))
      .flatMap((plugin) => Object.values(plugin.providerUsageAuthEnvVars ?? {}).flat()),
  );
}

function resolveManifestProviderAuthEnvVarCandidates(
  params: ProviderEnvVarLookupParams | undefined,
  snapshot: PluginMetadataSnapshot,
  sortedAliases: readonly (readonly [string, string])[],
): Record<string, string[]> {
  const candidates: Record<string, string[]> = Object.create(null);
  for (const { plugin, envProviders } of snapshot.owners.providerAuthContributions) {
    if (envProviders.length === 0 || !shouldUsePluginProviderEnvVars(plugin, params)) {
      continue;
    }
    for (const provider of envProviders) {
      appendUniqueEnvVarCandidates(candidates, provider.id, provider.envVars ?? []);
    }
  }
  for (const [alias, target] of sortedAliases) {
    const keys = candidates[target];
    if (keys) {
      appendUniqueEnvVarCandidates(candidates, alias, keys);
    }
  }
  return candidates;
}

function resolveManifestRuntimeAuthFacts(
  params: ProviderEnvVarLookupParams | undefined,
  snapshot: PluginMetadataSnapshot,
  aliasEntries: readonly (readonly [string, string])[],
  sortedAliases: readonly (readonly [string, string])[],
) {
  const evidenceByProvider: Record<string, ProviderAuthEvidence[]> = Object.create(null);
  const refs = new Set<string>();
  const isEnabled = createInstalledPluginEnabledPredicate(
    snapshot.index.plugins,
    params?.config,
    params?.env,
  );
  for (const { plugin, evidenceProviders, fallbackProviderRefs } of snapshot.owners
    .providerAuthContributions) {
    if (evidenceProviders.length === 0 && fallbackProviderRefs.length === 0) {
      continue;
    }
    // Package contributions are fixed, but their eligibility follows current config.
    // Evaluate each contributing owner once without narrowing credential-scrubbing hints.
    if (snapshot.index.plugins.length > 0 && !isEnabled(plugin.id)) {
      continue;
    }
    if (shouldUsePluginProviderAuthEvidence(plugin, params)) {
      for (const provider of evidenceProviders) {
        appendUniqueAuthEvidence(evidenceByProvider, provider.id, provider.authEvidence ?? []);
      }
    }
    for (const providerId of fallbackProviderRefs) {
      refs.add(providerId);
    }
  }
  for (const [alias, target] of sortedAliases) {
    const evidence = evidenceByProvider[target];
    if (evidence) {
      appendUniqueAuthEvidence(evidenceByProvider, alias, evidence);
    }
  }
  // Fallback refs keep insertion order; sorting would change one-pass alias-chain expansion.
  for (const [alias, target] of aliasEntries) {
    if (refs.has(target)) {
      appendUniqueProviderRef(refs, alias);
    }
  }
  return {
    authEvidenceMap: evidenceByProvider,
    setupProviderFallbackRefs: [...refs].toSorted((a, b) => a.localeCompare(b)),
  };
}

/** Resolves provider auth env-var candidates from core fallbacks and plugin metadata. */
export function resolveProviderAuthEnvVarCandidatesCore(
  params?: ProviderEnvVarLookupParams,
): Record<string, readonly string[]> {
  const snapshot = resolveProviderMetadataSnapshot(params);
  const aliases = resolveProviderAuthAliasMap({ ...params, metadataSnapshot: snapshot });
  const sortedAliases = Object.entries(aliases).toSorted(([left], [right]) =>
    left.localeCompare(right),
  );
  return {
    ...resolveManifestProviderAuthEnvVarCandidates(params, snapshot, sortedAliases),
    ...CORE_PROVIDER_AUTH_ENV_VAR_CANDIDATES,
  };
}

/** Resolves all provider auth lookup maps from a single metadata snapshot. */
export function resolveProviderAuthLookupMaps(
  params?: ProviderEnvVarLookupParams,
): ProviderAuthLookupMaps {
  const snapshot = resolveProviderMetadataSnapshot(params);
  const lookupParams = {
    ...params,
    metadataSnapshot: snapshot,
  };
  const aliasMap = resolveProviderAuthAliasMap(lookupParams);
  const aliasEntries = Object.entries(aliasMap);
  const sortedAliases = aliasEntries.toSorted(([left], [right]) => left.localeCompare(right));
  return {
    aliasMap,
    envCandidateMap: {
      ...resolveManifestProviderAuthEnvVarCandidates(params, snapshot, sortedAliases),
      ...CORE_PROVIDER_AUTH_ENV_VAR_CANDIDATES,
    },
    ...resolveManifestRuntimeAuthFacts(params, snapshot, aliasEntries, sortedAliases),
  };
}

/** Resolves env vars used by setup, default SecretRefs, and broad secret scrubbing. */
function withSetupEnvOverrides(
  authCandidates: Readonly<Record<string, readonly string[]>>,
): Record<string, readonly string[]> {
  return {
    ...authCandidates,
    ...CORE_PROVIDER_SETUP_ENV_VAR_OVERRIDES,
  };
}

/**
 * Provider env vars used for setup/default secret refs and broad secret
 * scrubbing. This can include non-model providers and may intentionally choose
 * a different preferred first env var than auth resolution.
 *
 * Bundled provider auth envs come from plugin manifests. The override map here
 * is only for true core/non-plugin providers and a few setup-specific ordering
 * overrides where generic onboarding wants a different preferred env var.
 */
let providerEnvVarsCache: Record<string, readonly string[]> | undefined;

/** Returns known env var candidates for a provider id or alias. */
export function getProviderEnvVarsCore(
  providerId: string,
  params?: ProviderEnvVarLookupParams,
): string[] {
  const providerEnvVars = params
    ? withSetupEnvOverrides(resolveProviderAuthEnvVarCandidatesCore(params))
    : (providerEnvVarsCache ??= withSetupEnvOverrides(resolveProviderAuthEnvVarCandidatesCore()));
  const envVars = Object.hasOwn(providerEnvVars, providerId)
    ? providerEnvVars[providerId]
    : undefined;
  return Array.isArray(envVars) ? [...envVars] : [];
}

// OPENCLAW_API_KEY authenticates the local OpenClaw bridge itself and must
// remain available to child bridge/runtime processes.
/** Lists known provider auth env vars without bridge-only env vars. */
export function listKnownProviderAuthEnvVarNamesCore(
  params?: ProviderEnvVarLookupParams,
): string[] {
  const authCandidates = resolveProviderAuthEnvVarCandidatesCore(params);
  // Keep auth-only candidates before setup overrides, then append usage-only hints.
  return uniqueStrings([
    ...Object.values(authCandidates).flat(),
    ...Object.values(withSetupEnvOverrides(authCandidates)).flat(),
    ...resolveManifestProviderUsageAuthEnvVarNames(params),
  ]);
}

/** Prepare machine-owned discovery facts before deriving the same provider env-name policy. */
export async function listKnownProviderAuthEnvVarNamesAsync(
  params?: ProviderEnvVarLookupParams,
): Promise<string[]> {
  if (params?.metadataSnapshot) {
    return listKnownProviderAuthEnvVarNamesCore(params);
  }
  const env = cloneEnvWithPlatformSemantics(params?.env ?? process.env);
  const lookup = { ...params, env };
  const cache = getPluginCache();
  const release = retainPluginCache(cache);
  try {
    return await withPluginCache(cache, async () => {
      let metadataSnapshot = findProviderMetadataSnapshot(lookup, {
        allowSynchronousPolicyRead: false,
      });
      if (!metadataSnapshot) {
        const activate = await prepareBundledDiscoveryMode(env);
        activate();
        metadataSnapshot = resolveProviderMetadataSnapshot(lookup);
      }
      return listKnownProviderAuthEnvVarNamesCore({ ...lookup, metadataSnapshot });
    });
  } finally {
    release();
  }
}

/** Lists secret env vars for auditing and cleanup, independently of provider activation. */
export function listKnownSecretEnvVarNames(params?: ProviderEnvVarLookupParams): string[] {
  return uniqueStrings([
    "GH_TOKEN",
    "GITHUB_TOKEN",
    ...Object.values(withSetupEnvOverrides(resolveProviderAuthEnvVarCandidatesCore(params))).flat(),
    ...resolveManifestProviderUsageAuthEnvVarNames(params),
  ]);
}

/** Returns a copy of an env object with denied keys removed case-insensitively. */
export function omitEnvKeysCaseInsensitive(
  baseEnv: NodeJS.ProcessEnv,
  keys: Iterable<string>,
): NodeJS.ProcessEnv {
  const env = { ...baseEnv };
  const denied = new Set<string>();
  for (const key of keys) {
    const normalizedKey = key.trim();
    if (normalizedKey) {
      denied.add(normalizedKey.toUpperCase());
    }
  }
  if (denied.size === 0) {
    return env;
  }
  for (const actualKey of Object.keys(env)) {
    if (denied.has(actualKey.toUpperCase())) {
      delete env[actualKey];
    }
  }
  return env;
}
