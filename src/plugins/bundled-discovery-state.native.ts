import { readConfigMachineState } from "../state/config-machine-state.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  getPreparedBundledDiscoveryMode,
  publishBundledDiscoveryMode,
  readBundledDiscoveryFact,
  resolveBundledDiscoveryOptions,
} from "./bundled-discovery-state.js";

/** Explicit boot, Doctor and offline CLI read; ordinary runtime uses async preparation. */
export function readBundledDiscoveryModeNative(
  options: OpenClawStateDatabaseOptions = {},
  behavior: { artifactPreservingReadOnly?: boolean } = {},
): "compat" | "allowlist" | undefined {
  const resolved = resolveBundledDiscoveryOptions(options);
  const value = readBundledDiscoveryFact(() =>
    readConfigMachineState<unknown>("plugins.bundledDiscovery", resolved, behavior),
  );
  return value === "compat" || value === "allowlist" ? value : undefined;
}

/** Native metadata admission may batch this read with its installed-index row. */
export function prepareBundledDiscoveryModeNative(
  env: NodeJS.ProcessEnv = process.env,
  behavior: { artifactPreservingReadOnly?: boolean } = {},
  readPreparedValue?: (databasePath: string) => unknown,
): "compat" | "allowlist" | undefined {
  const prepared = getPreparedBundledDiscoveryMode(env, behavior);
  if (prepared) {
    return prepared.value;
  }
  if (!readPreparedValue) {
    return publishBundledDiscoveryMode(
      readBundledDiscoveryModeNative({ env }, behavior),
      env,
      behavior,
    );
  }
  const options = resolveBundledDiscoveryOptions({ env });
  const value = readBundledDiscoveryFact(() =>
    readPreparedValue(resolveOpenClawStateSqlitePath(options.env ?? process.env)),
  );
  return publishBundledDiscoveryMode(value, env, behavior);
}
