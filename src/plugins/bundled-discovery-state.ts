// Bundled-discovery compatibility is machine-owned upgrade state.
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { readConfigMachineStateAsync } from "../state/config-machine-state-async.js";
import { isStateDatabaseReadAdmissionInvalidatedError } from "../state/openclaw-state-db-async-lifecycle.js";
import {
  getActiveOpenClawStateDatabaseReadSnapshot,
  isArtifactPreservingStateRead,
} from "../state/openclaw-state-db-readonly.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  hasActivePluginInstallRoots,
  resolveActivePluginInstallRoots,
} from "./install-root-context.js";
import {
  getPluginCache,
  getProcessPluginCache,
  preparePluginCacheFact,
  PluginCacheFactInvalidatedError,
} from "./plugin-cache.js";
import { registerPluginMetadataProcessMemoLifecycleClear } from "./plugin-metadata-lifecycle.js";
import { readPluginMetadataStateRow } from "./plugin-metadata-state-worker.js";

type BundledDiscoveryMode = "compat" | "allowlist" | undefined;
type BundledDiscoveryFact = { value: BundledDiscoveryMode };

function parseBundledDiscoveryMode(value: unknown): BundledDiscoveryMode {
  return value === "compat" || value === "allowlist" ? value : undefined;
}

export function readBundledDiscoveryFact<T>(read: () => T): T {
  try {
    return read();
  } catch (error) {
    if (isStateDatabaseReadAdmissionInvalidatedError(error)) {
      throw new PluginCacheFactInvalidatedError(
        "Plugin discovery read admission changed during preparation; retry the operation.",
        { cause: error },
      );
    }
    throw error;
  }
}

export function resolveBundledDiscoveryOptions(
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

// Process facts keyed by the resolved state-database path: the mode
// is machine-owned upgrade state that only changes through doctor/restart, and
// per-plugin activation must not open SQLite once per decision. The key keeps
// interleaved isolated scopes (agent execution, doctor lint) from inheriting
// another root's cached mode; the reads honor the active install-root context.
const discoveryState = resolveGlobalSingleton<{
  modes: Map<string, BundledDiscoveryFact>;
  snapshotModes: WeakMap<object, BundledDiscoveryFact>;
  artifactModes: WeakMap<object, Map<string, BundledDiscoveryFact>>;
}>(Symbol.for("openclaw.bundledDiscoveryMode"), () => ({
  modes: new Map(),
  snapshotModes: new WeakMap(),
  artifactModes: new WeakMap(),
}));

registerPluginMetadataProcessMemoLifecycleClear(() => {
  clearBundledDiscoveryModeMemo();
});

function resolveBundledDiscoveryMemoKey(env: NodeJS.ProcessEnv): string {
  const scopedEnv = hasActivePluginInstallRoots()
    ? { ...env, OPENCLAW_STATE_DIR: resolveActivePluginInstallRoots(env).stateDir }
    : env;
  return resolveOpenClawStateSqlitePath(scopedEnv);
}

function getArtifactDiscoveryModes(owner: object): Map<string, BundledDiscoveryFact> {
  let modes = discoveryState.artifactModes.get(owner);
  if (!modes) {
    modes = new Map();
    discoveryState.artifactModes.set(owner, modes);
  }
  return modes;
}

/** Return an already prepared fact; absence differs from a prepared legacy default. */
export function getPreparedBundledDiscoveryMode(
  env: NodeJS.ProcessEnv = process.env,
  behavior: { artifactPreservingReadOnly?: boolean } = {},
): BundledDiscoveryFact | undefined {
  const artifact = behavior.artifactPreservingReadOnly || isArtifactPreservingStateRead();
  if (artifact) {
    const snapshot = readBundledDiscoveryFact(() =>
      getActiveOpenClawStateDatabaseReadSnapshot(resolveBundledDiscoveryOptions({ env })),
    );
    return snapshot
      ? discoveryState.snapshotModes.get(snapshot)
      : discoveryState.artifactModes
          .get(getPluginCache())
          ?.get(resolveBundledDiscoveryMemoKey(env));
  }
  const key = resolveBundledDiscoveryMemoKey(env);
  const current = discoveryState.modes.get(key);
  if (current) {
    return current;
  }
  const prepared = getPluginCache().preparedBundledDiscoveryModes.get(key);
  if (prepared && "value" in prepared) {
    const fact = { value: prepared.value.value };
    discoveryState.modes.set(key, fact);
    return fact;
  }
  return undefined;
}

/** Native admission and async preparation publish into the same lifecycle-owned fact cache. */
export function publishBundledDiscoveryMode(
  value: unknown,
  env: NodeJS.ProcessEnv = process.env,
  behavior: { artifactPreservingReadOnly?: boolean } = {},
): BundledDiscoveryMode {
  const fact = { value: parseBundledDiscoveryMode(value) };
  if (behavior.artifactPreservingReadOnly || isArtifactPreservingStateRead()) {
    const snapshot = readBundledDiscoveryFact(() =>
      getActiveOpenClawStateDatabaseReadSnapshot(resolveBundledDiscoveryOptions({ env })),
    );
    if (snapshot) {
      discoveryState.snapshotModes.set(snapshot, fact);
    } else {
      // A missing database has no captured bytes; keep its default in this inspection cache.
      getArtifactDiscoveryModes(getPluginCache()).set(resolveBundledDiscoveryMemoKey(env), fact);
    }
  } else {
    discoveryState.modes.set(resolveBundledDiscoveryMemoKey(env), fact);
  }
  return fact.value;
}

/** Runtime derivation consumes facts prepared by its async owner; it never opens SQLite. */
export function readBundledDiscoveryModeMemoized(
  env: NodeJS.ProcessEnv = process.env,
  behavior: { artifactPreservingReadOnly?: boolean } = {},
): BundledDiscoveryMode {
  const prepared = getPreparedBundledDiscoveryMode(env, behavior);
  if (!prepared) {
    throw new Error(
      "Bundled discovery mode is not prepared; await prepareBundledDiscoveryMode before deriving plugin metadata.",
    );
  }
  return prepared.value;
}

/** Prepare the same machine-owned fact for synchronous metadata derivation. */
export async function prepareBundledDiscoveryMode(
  env: NodeJS.ProcessEnv = process.env,
  readPreparedRow?: (databasePath: string) => Promise<{ value_json: string } | undefined>,
): Promise<() => void> {
  const owner = getPluginCache();
  const options = resolveBundledDiscoveryOptions({ env });
  const artifact = isArtifactPreservingStateRead();
  if (artifact) {
    const snapshot = readBundledDiscoveryFact(() =>
      getActiveOpenClawStateDatabaseReadSnapshot(options),
    );
    let existing: BundledDiscoveryFact | undefined;
    let publish: (fact: BundledDiscoveryFact) => void;
    if (snapshot) {
      existing = discoveryState.snapshotModes.get(snapshot);
      publish = (fact) => {
        discoveryState.snapshotModes.set(snapshot, fact);
      };
    } else {
      const modes = getArtifactDiscoveryModes(owner);
      const key = resolveBundledDiscoveryMemoKey(env);
      existing = modes.get(key);
      publish = (fact) => {
        modes.set(key, fact);
      };
    }
    // Reactivation only publishes to the captured owner, even if called from a later scope.
    if (existing) {
      const fact = existing;
      return () => {
        publish(fact);
      };
    }
    // The read worker retains these snapshot bytes; derivation consumes its result locally.
    let value: BundledDiscoveryMode;
    try {
      value = parseBundledDiscoveryMode(
        await readConfigMachineStateAsync("plugins.bundledDiscovery", options, {
          artifactPreservingReadOnly: true,
        }),
      );
    } catch (error) {
      if (isStateDatabaseReadAdmissionInvalidatedError(error)) {
        throw new PluginCacheFactInvalidatedError(
          "Plugin discovery read admission changed during preparation; retry the operation.",
          { cause: error },
        );
      }
      throw error;
    }
    const fact = { value };
    const activate = () => {
      publish(fact);
    };
    activate();
    return activate;
  }
  const cache = owner.preparedBundledDiscoveryModes;
  const key = resolveBundledDiscoveryMemoKey(env);
  const prepared = await preparePluginCacheFact(owner, cache, key, async () => {
    let value: BundledDiscoveryMode;
    const current = discoveryState.modes.get(key);
    if (current) {
      value = current.value;
    } else {
      const row = readPreparedRow
        ? await readPreparedRow(key)
        : await readPluginMetadataStateRow(
            "bundled-discovery",
            resolveBundledDiscoveryOptions({ env }),
          );
      value = parseBundledDiscoveryMode(row ? JSON.parse(row.value_json) : undefined);
    }
    // Keep the SDK-reachable fact shape without a separate invalidation generation.
    return { value, generation: owner };
  });
  const activate = () => {
    prepared.assertCurrent();
    // Reuse this operation's captured fact for the following synchronous derivation.
    discoveryState.modes.set(key, { value: prepared.value.value });
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
  discoveryState.modes.clear();
  discoveryState.snapshotModes = new WeakMap();
  discoveryState.artifactModes = new WeakMap();
  for (const cache of new Set([getPluginCache(), getProcessPluginCache()])) {
    cache.preparedBundledDiscoveryModes.clear();
  }
}
