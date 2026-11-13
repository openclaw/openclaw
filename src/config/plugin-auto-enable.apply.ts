import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { registerPluginMetadataProcessMemoLifecycleClear } from "../plugins/plugin-metadata-lifecycle.js";
import { withPluginSetupPreparation } from "../plugins/plugin-setup-module.js";
import { freezeJsonSnapshot } from "../shared/immutable-data.js";
import { detectPluginAutoEnableCandidates } from "./plugin-auto-enable.detect.js";
import { materializePluginAutoEnableCandidatesInternal } from "./plugin-auto-enable.materialize.js";
import {
  preparePluginAutoEnableSetup,
  resolvePluginAutoEnableManifestRegistry,
} from "./plugin-auto-enable.shared.js";
import type {
  PluginAutoEnableCandidate,
  PluginAutoEnableConfigCache,
  PluginAutoEnableDiscoveryCache,
  PluginAutoEnableResult,
  PluginAutoEnableRuntimePreparation,
} from "./plugin-auto-enable.types.js";
import type { OpenClawConfig } from "./types.openclaw.js";

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
  params: Parameters<typeof detectPluginAutoEnableCandidates>[0] & {
    runtimePreparation?: PluginAutoEnableRuntimePreparation;
  },
): PluginAutoEnableResult {
  const config = params.config;
  const ambientEnvTriggers = params.ambientEnvTriggers ?? "allow";
  const env = params.env ?? process.env;
  const runtime = params.runtimePreparation;
  const capturedConfig = runtime?.capturedConfig;
  const discoveryKey = runtime?.metadataKey ?? params.discovery;
  let discoveryCache: PluginAutoEnableDiscoveryCache | undefined;
  if (config && params.manifestRegistry && discoveryKey) {
    const envCache = getOrCreateWeakMap(
      runtime?.cache ?? (sameTurnApplyCache ??= new WeakMap()),
      config,
    );
    const registryCache = getOrCreateWeakMap(envCache, runtime?.envKey ?? env);
    discoveryCache = getOrCreateWeakMap(registryCache, params.manifestRegistry);
    const cached = discoveryCache.get(discoveryKey);
    if (
      cached &&
      cached.capturedConfig === capturedConfig &&
      cached.candidates === params.discovery?.candidates &&
      cached.plugins === params.manifestRegistry.plugins &&
      cached.ambientEnvTriggers === ambientEnvTriggers
    ) {
      return cached.result;
    }
  }

  const preparationConfig = capturedConfig ?? config;
  const candidates = detectPluginAutoEnableCandidates({ ...params, config: preparationConfig });
  const result = materializePluginAutoEnableCandidates({
    config: preparationConfig,
    candidates,
    env: params.env,
    manifestRegistry: params.manifestRegistry,
  });
  if (runtime) {
    // Preserve the no-rewrite identity without freezing the mutable publication.
    // Rewritten captures reuse config-state's existing immutable policy projection.
    if (result.config === capturedConfig) {
      result.config = config!;
    } else {
      freezeJsonSnapshot(result.config);
    }
  }
  if (discoveryCache && discoveryKey && params.manifestRegistry) {
    discoveryCache.set(discoveryKey, {
      capturedConfig,
      candidates: params.discovery?.candidates,
      plugins: params.manifestRegistry.plugins,
      ambientEnvTriggers,
      result,
    });
    if (!runtime) {
      scheduleSameTurnApplyCacheClear();
    }
  }
  return result;
}

/** Prepare setup probes before applying the same synchronous activation policy. */
export async function applyPluginAutoEnableAsync(
  params: Parameters<typeof applyPluginAutoEnable>[0],
): Promise<PluginAutoEnableResult> {
  return withPluginSetupPreparation({}, async ({ assertCurrent }) => {
    await preparePluginAutoEnableSetup({ ...params, config: params.config ?? {}, assertCurrent });
    assertCurrent();
    return applyPluginAutoEnable(params);
  });
}
