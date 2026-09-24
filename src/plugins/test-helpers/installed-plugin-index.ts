import type { PluginInstallRecord } from "../../config/types.plugins.js";
import { refreshPersistedInstalledPluginIndex } from "../installed-plugin-index-store-write.js";

/** Seed fixture state without adding an unleased production record writer. */
export async function seedInstalledPluginIndex(
  records: Record<string, PluginInstallRecord>,
  options: Omit<
    Parameters<typeof refreshPersistedInstalledPluginIndex>[0],
    "reason" | "installRecords" | "lease"
  > = {},
): Promise<void> {
  refreshPersistedInstalledPluginIndex({
    ...options,
    reason: "source-changed",
    installRecords: records,
  });
}
