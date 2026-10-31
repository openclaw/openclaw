import type { PluginInstallRecord } from "../config/types.plugins.js";
import { VERSION } from "../version.js";
import { hashStableJson } from "./installed-plugin-index-hash.js";
import { getPluginConfiguredConditions } from "./plugin-native-resolution.js";

/** Only installer-owned copies can publish a frozen source generation. */
export function isManagedPluginSnapshotSource(record: PluginInstallRecord): boolean {
  return record.source !== "path" && Boolean(record.installPath?.trim());
}

/** Capture/resolution inputs not already covered by the source closure itself. */
export function pluginSourceSnapshotOptionsDigest(env: NodeJS.ProcessEnv = process.env): string {
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
    conditions: [...getPluginConfiguredConditions()].toSorted(),
    addons: !process.execArgv.includes("--no-addons"),
    preserveSymlinks: process.execArgv.includes("--preserve-symlinks"),
    options: Object.fromEntries(keys.map((key) => [key, env[key] ?? null])),
  });
}
