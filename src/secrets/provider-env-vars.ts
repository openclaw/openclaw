import { resolveProviderAuthAliasMap } from "../agents/provider-auth-aliases.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadPluginManifestRegistry } from "../plugins/manifest-registry.js";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import {
  isWorkspacePluginAllowedByConfig,
  normalizePluginConfigId,
} from "../plugins/plugin-config-trust.js";
import { hasKind } from "../plugins/slots.js";

const CORE_PROVIDER_AUTH_ENV_VAR_CANDIDATES = {
  anthropic: ["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  voyage: ["VOYAGE_API_KEY"],
  cerebras: ["CEREBRAS_API_KEY"],
  "anthropic-openai": ["ANTHROPIC_API_KEY"],
  "qwen-dashscope": ["DASHSCOPE_API_KEY"],
} as const;

const CORE_PROVIDER_SETUP_ENV_VAR_OVERRIDES = {
  "minimax-cn": ["MINIMAX_API_KEY"],
} as const;

export type ProviderEnvVarLookupParams = {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  includeUntrustedWorkspacePlugins?: boolean;
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
  return isWorkspacePluginTrustedForProviderEnvVars(plugin, params?.config);
}

// Safe env var name validation: only allow conventional uppercase-with-underscores names.
// Reject known high-value unrelated secrets to prevent accidental exfiltration.
// Note: GITHUB_TOKEN, NPM_TOKEN etc are valid provider auth env vars for some providers
// (e.g. GitHub Copilot), so we don't denylist them here. The regex validation below
// already prevents injection of lowercase or path-like names.
const DANGEROUS_ENV_NAMES = new Set([
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "SSH_AUTH_SOCK",
  "SSH_KEY",
]);

function isSafeEnvVarName(name: string): boolean {
  const trimmed = name.trim();
  // Must match conventional uppercase-with-underscores pattern
  if (!/^[A-Z_][A-Z0-9_]{0,63}$/.test(trimmed)) {
    return false;
  }
  // Reject known dangerous unrelated secrets
  if (DANGEROUS_ENV_NAMES.has(trimmed)) {
    return false;
  }
  return true;
}

// Block prototype pollution keys
const PROTOTYPE_POLLUTION_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function appendUniqueEnvVarCandidates(
  target: Record<string, string[]>,
  providerId: string,
  keys: readonly string[],
) {
  const normalizedProviderId = providerId.trim();
  // Prevent prototype pollution from untrusted providerId
  if (!normalizedProviderId || PROTOTYPE_POLLUTION_KEYS.has(normalizedProviderId)) {
    return;
  }
  if (keys.length === 0) {
    return;
  }
  const bucket = (target[normalizedProviderId] ??= []);
  const seen = new Set(bucket);
  for (const key of keys) {
    const normalizedKey = key.trim();
    if (!normalizedKey || seen.has(normalizedKey)) {
      continue;
    }
    // Validate env var names to prevent secret exfiltration
    if (!isSafeEnvVarName(normalizedKey)) {
      continue;
    }
    seen.add(normalizedKey);
    bucket.push(normalizedKey);
  }
}

function resolveManifestProviderAuthEnvVarCandidates(
  params?: ProviderEnvVarLookupParams,
): Record<string, string[]> {
  const registry = loadPluginManifestRegistry({
    config: params?.config,
    workspaceDir: params?.workspaceDir,
    env: params?.env,
  });
  // Use null-prototype object to prevent prototype pollution from untrusted providerId keys
  const candidates: Record<string, string[]> = Object.create(null);
  for (const plugin of registry.plugins) {
    if (!shouldUsePluginProviderEnvVars(plugin, params)) {
      continue;
    }
    if (!plugin.providerAuthEnvVars) {
      continue;
    }
    for (const [providerId, keys] of Object.entries(plugin.providerAuthEnvVars).toSorted(
      ([left], [right]) => left.localeCompare(right),
    )) {
      appendUniqueEnvVarCandidates(candidates, providerId, keys);
    }
  }
  const aliases = resolveProviderAuthAliasMap(params);
  for (const [alias, target] of Object.entries(aliases).toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const keys = candidates[target];
    if (keys) {
      appendUniqueEnvVarCandidates(candidates, alias, keys);
    }
  }
  return candidates;
}

export function resolveProviderAuthEnvVarCandidates(
  params?: ProviderEnvVarLookupParams,
): Record<string, readonly string[]> {
  // Use null-prototype object to prevent prototype pollution
  const result: Record<string, readonly string[]> = Object.create(null);
  const manifest = resolveManifestProviderAuthEnvVarCandidates(params);
  for (const [key, value] of Object.entries(manifest)) {
    result[key] = value;
  }
  for (const [key, value] of Object.entries(CORE_PROVIDER_AUTH_ENV_VAR_CANDIDATES)) {
    result[key] = value;
  }
  return result;
}

export function resolveProviderEnvVars(
  params?: ProviderEnvVarLookupParams,
): Record<string, readonly string[]> {
  return {
    ...resolveProviderAuthEnvVarCandidates(params),
    ...CORE_PROVIDER_SETUP_ENV_VAR_OVERRIDES,
  };
}

const lazyRecordCacheResetters = new Set<() => void>();

function createLazyReadonlyRecord(
  resolve: () => Record<string, readonly string[]>,
): Record<string, readonly string[]> {
  let cached: Record<string, readonly string[]> | undefined;
  lazyRecordCacheResetters.add(() => {
    cached = undefined;
  });
  const getResolved = (): Record<string, readonly string[]> => {
    cached ??= resolve();
    return cached;
  };

  return new Proxy({} as Record<string, readonly string[]>, {
    get(_target, prop) {
      if (typeof prop !== "string") {
        return undefined;
      }
      const v = getResolved()[prop];
      // Return defensive copy to prevent mutation of shared cached arrays
      return Array.isArray(v) ? [...v] : v;
    },
    has(_target, prop) {
      return typeof prop === "string" && Object.hasOwn(getResolved(), prop);
    },
    ownKeys() {
      return Reflect.ownKeys(getResolved());
    },
    getOwnPropertyDescriptor(_target, prop) {
      if (typeof prop !== "string") {
        return undefined;
      }
      const value = getResolved()[prop];
      if (value === undefined) {
        return undefined;
      }
      return {
        configurable: true,
        enumerable: true,
        value,
        writable: false,
      };
    },
  });
}

/**
 * Provider auth env candidates used by generic auth resolution.
 *
 * Order matters: the first non-empty value wins for helpers such as
 * `resolveEnvApiKey()`. Bundled providers source this from plugin manifest
 * metadata so auth probes do not need to load plugin runtime.
 */
export const PROVIDER_AUTH_ENV_VAR_CANDIDATES = createLazyReadonlyRecord(() =>
  resolveProviderAuthEnvVarCandidates(),
);

/**
 * Provider env vars used for setup/default secret refs and broad secret
 * scrubbing. This can include non-model providers and may intentionally choose
 * a different preferred first env var than auth resolution.
 *
 * Bundled provider auth envs come from plugin manifests. The override map here
 * is only for true core/non-plugin providers and a few setup-specific ordering
 * overrides where generic onboarding wants a different preferred env var.
 */
export const PROVIDER_ENV_VARS = createLazyReadonlyRecord(() => resolveProviderEnvVars());

export const __testing = {
  resetProviderEnvVarCachesForTests(): void {
    for (const reset of lazyRecordCacheResetters) {
      reset();
    }
  },
};

export function getProviderEnvVars(
  providerId: string,
  params?: ProviderEnvVarLookupParams,
): string[] {
  const providerEnvVars = resolveProviderEnvVars(params);
  const envVars = Object.hasOwn(providerEnvVars, providerId)
    ? providerEnvVars[providerId]
    : undefined;
  return Array.isArray(envVars) ? [...envVars] : [];
}

const EXTRA_PROVIDER_AUTH_ENV_VARS = ["MINIMAX_CODE_PLAN_KEY", "MINIMAX_CODING_API_KEY"] as const;

// OPENCLAW_API_KEY authenticates the local OpenClaw bridge itself and must
// remain available to child bridge/runtime processes.
export function listKnownProviderAuthEnvVarNames(params?: ProviderEnvVarLookupParams): string[] {
  return [
    ...new Set([
      ...Object.values(resolveProviderAuthEnvVarCandidates(params)).flatMap((keys) => keys),
      ...Object.values(resolveProviderEnvVars(params)).flatMap((keys) => keys),
      ...EXTRA_PROVIDER_AUTH_ENV_VARS,
    ]),
  ];
}

export function listKnownSecretEnvVarNames(params?: ProviderEnvVarLookupParams): string[] {
  return [...new Set(Object.values(resolveProviderEnvVars(params)).flatMap((keys) => keys))];
}

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
