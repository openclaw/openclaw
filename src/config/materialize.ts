import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { isPlainObject, resolveUserPath } from "../utils.js";
import { attachAgentListProjection } from "./agent-list-projection.js";
import {
  applyCompactionDefaults,
  applyContextPruningDefaults,
  applyAgentDefaults,
  applyMessageDefaults,
  applyModelDefaults,
  applySessionDefaults,
} from "./defaults.js";
import { normalizeExecSafeBinProfilesInConfig } from "./normalize-exec-safe-bin.js";
import { captureConfigResolutionFactsThroughRewrite } from "./resolution-facts.js";
import { projectSkillWorkshopPluginPolicy } from "./skill-workshop-plugin-migration.js";
import { normalizeTalkConfig } from "./talk.js";
import type { OpenClawConfig, ResolvedSourceConfig, RuntimeConfig } from "./types.js";

const PATH_VALUE_RE = /^~(?=$|[\\/])/;
const PATH_KEY_RE = /(dir|path|paths|file|root|workspace)$/i;
const PATH_LIST_KEYS = new Set(["paths", "pathPrepend"]);

// Snapshot and load must materialize identically: prepared-runtime exact-config
// resolution compares the startup-published (snapshot) config against the reply-path
// (load) config, and any divergence permanently fails that resolve for affected configs.

export function asResolvedSourceConfig(config: OpenClawConfig): ResolvedSourceConfig {
  return config as ResolvedSourceConfig;
}

export function asRuntimeConfig(config: OpenClawConfig): RuntimeConfig {
  return config as RuntimeConfig;
}

export function materializeRuntimeConfig(
  config: OpenClawConfig,
  options: {
    env?: NodeJS.ProcessEnv;
    homedir?: () => string;
    manifestRegistry?: Pick<PluginManifestRegistry, "plugins">;
    loadManifestRegistry?: () => Pick<PluginManifestRegistry, "plugins"> | undefined;
  } = {},
): RuntimeConfig {
  const carryResolutionFacts = captureConfigResolutionFactsThroughRewrite(config);
  let next = applyMessageDefaults(config);
  next = applySessionDefaults(next);
  next = applyAgentDefaults(next);
  next = applyContextPruningDefaults(next, options);
  next = applyCompactionDefaults(next);
  next = applyModelDefaults(next, {
    manifestRegistry: options.manifestRegistry,
    loadManifestRegistry: options.loadManifestRegistry,
  });
  next = normalizeTalkConfig(next);
  // Unmarked configs keep the built-in Workshop outcome until Doctor records the migration.
  next = projectSkillWorkshopPluginPolicy(next).config;
  // Status can read a daemon's config from a different home. Capture that
  // resolution context once so nested paths cannot fall back to the CLI home.
  function normalizeAny(key: string | undefined, value: unknown): unknown {
    if (typeof value === "string") {
      return key &&
        PATH_VALUE_RE.test(value.trim()) &&
        (PATH_KEY_RE.test(key) || PATH_LIST_KEYS.has(key))
        ? resolveUserPath(value, options.env, options.homedir)
        : value;
    }
    if (Array.isArray(value)) {
      const normalizeChildren = Boolean(key && PATH_LIST_KEYS.has(key));
      // Only direct string children of path lists inherit the field's path semantics.
      return value.map((entry) =>
        normalizeAny(typeof entry === "string" && normalizeChildren ? key : undefined, entry),
      );
    }
    if (isPlainObject(value)) {
      for (const [childKey, childValue] of Object.entries(value)) {
        const normalized = normalizeAny(childKey, childValue);
        if (normalized !== childValue) {
          value[childKey] = normalized;
        }
      }
    }
    return value;
  }
  normalizeAny(undefined, next);
  normalizeExecSafeBinProfilesInConfig(next);
  carryResolutionFacts(next);
  return asRuntimeConfig(next.agents?.entries ? attachAgentListProjection(next) : next);
}
