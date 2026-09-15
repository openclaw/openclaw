// Bundled-discovery compatibility is machine-owned upgrade state.
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { readConfigMachineState } from "../state/config-machine-state.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  hasActivePluginInstallRoots,
  resolveActivePluginInstallRoots,
} from "./install-root-context.js";
import {
  getPluginCache,
  getPluginCacheRetirementSignal,
  getProcessPluginCache,
  preparePluginCacheFact,
  PluginCacheFactInvalidatedError,
} from "./plugin-cache.js";
import { registerPluginMetadataProcessMemoLifecycleClear } from "./plugin-metadata-lifecycle.js";
import { readPluginMetadataStateRow } from "./plugin-metadata-state-worker.js";

type BundledDiscoveryMode = "compat" | "allowlist" | undefined;

function parseBundledDiscoveryMode(value: unknown): BundledDiscoveryMode {
  return value === "compat" || value === "allowlist" ? value : undefined;
}

function resolveBundledDiscoveryOptions(
  options: OpenClawStateDatabaseOptions,
): OpenClawStateDatabaseOptions {
  return options.path || options.database || !hasActivePluginInstallRoots()
    ? options
    : {
        ...options,
        env: {
          ...(options.env ?? process.env),
          OPENCLAW_STATE_DIR: resolveActivePluginInstallRoots(options.env).stateDir,
        },
      };
}

export function readBundledDiscoveryMode(
  options: OpenClawStateDatabaseOptions = {},
  behavior: { artifactPreservingReadOnly?: boolean } = {},
): "compat" | "allowlist" | undefined {
  const resolvedOptions = resolveBundledDiscoveryOptions(options);
  const value = readConfigMachineState<unknown>(
    "plugins.bundledDiscovery",
    resolvedOptions,
    behavior,
  );
  return parseBundledDiscoveryMode(value);
}

// Single-slot process memo keyed by the resolved state-database path: the mode
// is machine-owned upgrade state that only changes through doctor/restart, and
// per-plugin activation must not open SQLite once per decision. The key keeps
// interleaved isolated scopes (agent execution, doctor lint) from inheriting
// another root's cached mode; the reads honor the active install-root context.
const discoveryState = resolveGlobalSingleton<{
  generation: object;
  memoized?: { key: string; value: BundledDiscoveryMode };
}>(Symbol.for("openclaw.bundledDiscoveryMode"), () => ({ generation: {} }));

registerPluginMetadataProcessMemoLifecycleClear(() => {
  clearBundledDiscoveryModeMemo();
});

function resolveBundledDiscoveryMemoKey(env: NodeJS.ProcessEnv): string {
  const scopedEnv = hasActivePluginInstallRoots()
    ? { ...env, OPENCLAW_STATE_DIR: resolveActivePluginInstallRoots(env).stateDir }
    : env;
  return resolveOpenClawStateSqlitePath(scopedEnv);
}

/**
 * Callers loading a registry with an explicit env pass it so the mode comes
 * from that env's state root; omitting it reads the process root. Pinned
 * install roots win over both, matching readBundledDiscoveryMode.
 */
export function readBundledDiscoveryModeMemoized(
  env: NodeJS.ProcessEnv = process.env,
  behavior: { artifactPreservingReadOnly?: boolean } = {},
  readPreparedValue?: (databasePath: string) => unknown,
): "compat" | "allowlist" | undefined {
  if (behavior.artifactPreservingReadOnly) {
    // Copied-state planning binds the observed bytes, not process-stable runtime metadata.
    // Read a private SQLite snapshot so neither cached state nor source WAL coordination leaks in.
    return readBundledDiscoveryMode(env === process.env ? {} : { env }, behavior);
  }
  const key = resolveBundledDiscoveryMemoKey(env);
  if (discoveryState.memoized?.key !== key) {
    const owner = getPluginCache();
    const prepared = owner.preparedBundledDiscoveryModes.get(key);
    if (
      prepared &&
      "value" in prepared &&
      prepared.value.generation === discoveryState.generation
    ) {
      getPluginCacheRetirementSignal(owner).throwIfAborted();
      discoveryState.memoized = { key, value: prepared.value.value };
    } else {
      discoveryState.memoized = {
        key,
        value: readPreparedValue
          ? parseBundledDiscoveryMode(readPreparedValue(key))
          : readBundledDiscoveryMode(env === process.env ? {} : { env }),
      };
    }
  }
  return discoveryState.memoized.value;
}

/** Prepare the same machine-owned fact for synchronous metadata derivation. */
export async function prepareBundledDiscoveryMode(
  env: NodeJS.ProcessEnv = process.env,
): Promise<() => void> {
  const owner = getPluginCache();
  const cache = owner.preparedBundledDiscoveryModes;
  const key = resolveBundledDiscoveryMemoKey(env);
  const generation = discoveryState.generation;
  const current = cache.get(key);
  if (current && "value" in current && current.value.generation !== generation) {
    cache.delete(key);
  }
  const prepared = await preparePluginCacheFact(owner, cache, key, async () => {
    let value: BundledDiscoveryMode;
    if (discoveryState.memoized?.key === key) {
      value = discoveryState.memoized.value;
    } else {
      const row = await readPluginMetadataStateRow(
        "bundled-discovery",
        resolveBundledDiscoveryOptions({ env }),
      );
      value = parseBundledDiscoveryMode(row ? JSON.parse(row.value_json) : undefined);
    }
    if (discoveryState.generation !== generation) {
      throw new PluginCacheFactInvalidatedError(
        "Plugin discovery state changed during preparation; retry the operation.",
      );
    }
    return { value, generation };
  });
  const activate = () => {
    prepared.assertCurrent();
    if (discoveryState.generation !== generation) {
      throw new PluginCacheFactInvalidatedError(
        "Plugin discovery state changed during preparation; retry the operation.",
      );
    }
    // Another root may use the single-slot memo while preparation awaits its row.
    // Reuse this operation's captured fact for the following synchronous derivation.
    discoveryState.memoized = { key, value: prepared.value.value };
  };
  activate();
  return activate;
}

/**
 * Clears the memo after a machine-state write so same-process readers observe
 * the new mode. Without this, doctor's migration could cache the pre-migration
 * absent mode and rebuild plugin indexes against stale strict-gate decisions.
 */
export function clearBundledDiscoveryModeMemo(): void {
  discoveryState.memoized = undefined;
  discoveryState.generation = {};
  for (const cache of new Set([getPluginCache(), getProcessPluginCache()])) {
    cache.preparedBundledDiscoveryModes.clear();
  }
}
