import type { AmbientEnvTriggerPolicy } from "../channels/config-presence.js";
import type { PluginDiscoveryResult } from "../plugins/discovery.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { registerPluginMetadataProcessMemoLifecycleClear } from "../plugins/plugin-metadata-lifecycle.js";
import { detectPluginAutoEnableCandidates } from "./plugin-auto-enable.detect.js";
import { materializePluginAutoEnableCandidatesInternal } from "./plugin-auto-enable.materialize.js";
import { resolvePluginAutoEnableManifestRegistry } from "./plugin-auto-enable.shared.js";
import type {
  PluginAutoEnableCandidate,
  PluginAutoEnableResult,
} from "./plugin-auto-enable.types.js";
import type { OpenClawConfig } from "./types.openclaw.js";

type PluginAutoEnableCacheEntry = {
  candidates: PluginDiscoveryResult["candidates"];
  plugins: PluginManifestRegistry["plugins"];
  ambientEnvTriggers: AmbientEnvTriggerPolicy;
  result: PluginAutoEnableResult;
};
type PluginAutoEnableDiscoveryCache = WeakMap<object, PluginAutoEnableCacheEntry>;
type PluginAutoEnableRegistryCache = WeakMap<object, PluginAutoEnableDiscoveryCache>;
type PluginAutoEnableEnvCache = WeakMap<object, PluginAutoEnableRegistryCache>;
type PluginAutoEnableConfigCache = WeakMap<object, PluginAutoEnableEnvCache>;

let sameTurnApplyCache: PluginAutoEnableConfigCache | undefined;
let sameTurnApplyCacheClearScheduled = false;

// Metadata snapshots are replaced; mutable discovery is invalidated by its lifecycle owner.
registerPluginMetadataProcessMemoLifecycleClear(() => {
  sameTurnApplyCache = undefined;
});

function scheduleSameTurnApplyCacheClear(): void {
  if (sameTurnApplyCacheClearScheduled) {
    return;
  }
  sameTurnApplyCacheClearScheduled = true;
  // process.env and discovery inputs can mutate; only dedupe one RPC fanout turn.
  const handle = setImmediate(() => {
    sameTurnApplyCache = undefined;
    sameTurnApplyCacheClearScheduled = false;
  });
  handle.unref?.();
}

function getOrCreateWeakMap<K extends object, ChildKey extends object, V>(
  parent: WeakMap<K, WeakMap<ChildKey, V>>,
  key: K,
): WeakMap<ChildKey, V> {
  let child = parent.get(key);
  if (!child) {
    child = new WeakMap();
    parent.set(key, child);
  }
  return child;
}

/** Applies already detected plugin auto-enable candidates to config. */
export function materializePluginAutoEnableCandidates(params: {
  config?: OpenClawConfig;
  candidates: readonly PluginAutoEnableCandidate[];
  env?: NodeJS.ProcessEnv;
  manifestRegistry?: PluginManifestRegistry;
}): PluginAutoEnableResult {
  const env = params.env ?? process.env;
  const config = params.config ?? {};
  const entries = config.plugins?.entries;
  const hasRestrictiveAllowlistWithEntries =
    Array.isArray(config.plugins?.allow) &&
    config.plugins.allow.length > 0 &&
    entries !== undefined &&
    typeof entries === "object";
  if (params.candidates.length === 0 && !hasRestrictiveAllowlistWithEntries) {
    return { config, changes: [], autoEnabledReasons: {} };
  }
  const manifestRegistry = resolvePluginAutoEnableManifestRegistry({
    config,
    env,
    manifestRegistry: params.manifestRegistry,
  });
  return materializePluginAutoEnableCandidatesInternal({
    config,
    candidates: params.candidates,
    env,
    manifestRegistry,
  });
}

export function applyPluginAutoEnable(
  params: Parameters<typeof detectPluginAutoEnableCandidates>[0],
): PluginAutoEnableResult {
  const config = params.config;
  const ambientEnvTriggers = params.ambientEnvTriggers ?? "allow";
  let discoveryCache: PluginAutoEnableDiscoveryCache | undefined;
  if (config && typeof config === "object" && params.manifestRegistry && params.discovery) {
    const env = params.env ?? process.env;
    const envCache = getOrCreateWeakMap((sameTurnApplyCache ??= new WeakMap()), config);
    const registryCache = getOrCreateWeakMap(envCache, env);
    discoveryCache = getOrCreateWeakMap(registryCache, params.manifestRegistry);
    const cached = discoveryCache.get(params.discovery);
    if (
      cached &&
      cached.candidates === params.discovery.candidates &&
      cached.plugins === params.manifestRegistry.plugins &&
      cached.ambientEnvTriggers === ambientEnvTriggers
    ) {
      return cached.result;
    }
  }

  const candidates = detectPluginAutoEnableCandidates(params);
  const result = materializePluginAutoEnableCandidates({
    config,
    candidates,
    env: params.env,
    manifestRegistry: params.manifestRegistry,
  });
  if (discoveryCache && params.discovery && params.manifestRegistry) {
    discoveryCache.set(params.discovery, {
      candidates: params.discovery.candidates,
      plugins: params.manifestRegistry.plugins,
      ambientEnvTriggers,
      result,
    });
    scheduleSameTurnApplyCacheClear();
  }
  return result;
}
