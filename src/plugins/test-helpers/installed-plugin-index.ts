import type { PluginInstallRecord } from "../../config/types.plugins.js";
import { refreshPersistedInstalledPluginIndex } from "../installed-plugin-index-store-write.js";
import type { InstalledPluginIndex } from "../installed-plugin-index.js";

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

export function createInstalledPluginIndex(
  overrides: Partial<InstalledPluginIndex> = {},
): InstalledPluginIndex {
  return {
    version: 1,
    hostContractVersion: "2026.4.25",
    compatRegistryVersion: "compat-v1",
    migrationVersion: 1,
    policyHash: "policy-v1",
    generatedAtMs: 1777118400000,
    installRecords: {},
    plugins: [
      {
        pluginId: "demo",
        manifestPath: "/plugins/demo/openclaw.plugin.json",
        manifestHash: "manifest-hash",
        rootDir: "/plugins/demo",
        origin: "global",
        packageBuild: { bundledDist: false },
        enabled: true,
        syntheticAuthRefs: ["demo"],
        startup: {
          sidecar: false,
          memory: false,
          agentHarnesses: [],
        },
        compat: [],
      },
    ],
    diagnostics: [],
    ...overrides,
  };
}
