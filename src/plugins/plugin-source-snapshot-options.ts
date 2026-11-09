import type { PluginInstallRecord } from "../config/types.plugins.js";
import { VERSION } from "../version.js";
import { hashStableJson } from "./installed-plugin-index-hash.js";
import { getPluginResolutionPolicy } from "./plugin-native-resolution.js";

export type ManagedPluginSnapshotIdentity = {
  installOwner: string;
  installRecordHash: string;
};

/** Only installer-owned copies can publish a frozen source generation. */
export function isManagedPluginSnapshotSource(record: PluginInstallRecord): boolean {
  return record.source !== "path" && Boolean(record.installPath?.trim());
}

/** Capture/resolution inputs not already covered by the source closure itself. */
export function pluginSourceSnapshotOptionsDigest(env: NodeJS.ProcessEnv = process.env): string {
  const policy = getPluginResolutionPolicy(env);
  // SAFETY: Bun exposes its revision on this runtime global; Node leaves it absent.
  const bun = (globalThis as typeof globalThis & { Bun?: { revision: string } }).Bun;
  const keys = [
    "JITI_ALIAS",
    "JITI_EXTENSIONS",
    "JITI_INTEROP_DEFAULT",
    "JITI_JSX",
    "JITI_NATIVE_MODULES",
    "JITI_SOURCE_MAPS",
    "JITI_TRANSFORM_MODULES",
    "JITI_TRY_NATIVE",
    "JITI_TSCONFIG_PATHS",
    "NODE_OPTIONS",
    "NODE_PATH",
  ];
  return hashStableJson({
    version: VERSION,
    node: process.versions.node,
    bun: process.versions.bun,
    bunRevision: bun?.revision,
    conditions: [...policy.conditions].toSorted(),
    addons: policy.addons,
    requireModule: policy.requireModule,
    preserveSymlinks: policy.preserveSymlinks,
    options: Object.fromEntries(keys.map((key) => [key, env[key] ?? null])),
  });
}

/** Match Jiti's environment parsing without consulting mutable filesystem configuration. */
export function resolvePluginSnapshotTsconfigPaths(
  env: NodeJS.ProcessEnv = process.env,
): boolean | string {
  const raw = env.JITI_TSCONFIG_PATHS;
  if (!raw) {
    return false;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    value = raw;
  }
  return typeof value === "string" ? value : Boolean(value);
}
