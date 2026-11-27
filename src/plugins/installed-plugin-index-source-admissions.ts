import type { InstalledPluginIndex } from "./installed-plugin-index-types.js";

/** A rebuilt projection retains admissions only for the same installed source owner. */
export function preservePluginSourceAdmissions(
  previous: InstalledPluginIndex | null,
  current: InstalledPluginIndex,
): void {
  const records = new Map(previous?.plugins.map((plugin) => [plugin.pluginId, plugin]));
  for (const plugin of current.plugins) {
    const prior = records.get(plugin.pluginId);
    if (
      prior?.sourceAdmissions &&
      prior.rootDir === plugin.rootDir &&
      prior.installRecordHash === plugin.installRecordHash
    ) {
      plugin.sourceAdmissions = { ...plugin.sourceAdmissions, ...prior.sourceAdmissions };
    }
  }
}
