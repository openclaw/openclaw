import { resolveUserPath } from "../infra/home-dir.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import {
  buildDegradedPluginsFromVerificationFailures,
  degradedPluginMatchesRoot,
  listActiveDegradedPlugins,
  pluginInstallPathMatchesRoot,
  setActiveDegradedPlugins,
} from "../plugins/runtime-degraded-state.js";

/** Refresh only the owned payloads explicitly reloaded at their quarantined roots. */
export async function reverifyReloadedPluginPayloads(
  requestedIds: ReadonlySet<string>,
  metadata: PluginMetadataSnapshot,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const records = listActiveDegradedPlugins().flatMap((plugin) => {
    if (!requestedIds.has(plugin.pluginId)) {
      return [];
    }
    const selected = metadata.byPluginId.get(plugin.pluginId);
    const record = metadata.index.installRecords[plugin.pluginId];
    if (
      !selected ||
      !record?.installPath ||
      !degradedPluginMatchesRoot(plugin, selected.rootDir) ||
      !pluginInstallPathMatchesRoot(resolveUserPath(record.installPath, env), selected.rootDir)
    ) {
      return [];
    }
    return [[plugin.pluginId, record] as const];
  });
  if (!records.length) {
    return;
  }
  const { runPluginPayloadSmokeCheck } = await import("../plugins/payload-verification.js");
  const { checked, failures } = await runPluginPayloadSmokeCheck({
    records: Object.fromEntries(records),
    env,
  });
  setActiveDegradedPlugins([
    ...listActiveDegradedPlugins().filter((entry) => !checked.includes(entry.pluginId)),
    ...buildDegradedPluginsFromVerificationFailures(failures),
  ]);
}
