import { vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { PluginDoctorStateMigration } from "../plugins/doctor-contract-module.js";

export const pluginDoctorStateMigrationEntries: {
  entries: Array<{
    pluginId: string;
    channelIds?: string[];
    trustedForDurableStores?: boolean;
    migration: PluginDoctorStateMigration;
  }>;
} = { entries: [] };

export const legacyChannelStateMigrationEntries = {
  entries: [] as Array<{ pluginId: string; migration: PluginDoctorStateMigration }>,
};

vi.mock("../plugins/doctor-contract-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/doctor-contract-registry.js")>();
  const buildStateMigrationInventory = (params?: { config?: OpenClawConfig }) => ({
    knownPluginIds: actual.collectRelevantDoctorPluginIds(params?.config ?? {}),
    sessionStoreOwnerPluginIds: [],
    descriptors: [
      ...pluginDoctorStateMigrationEntries.entries,
      ...legacyChannelStateMigrationEntries.entries,
    ].map((entry) =>
      Object.assign(
        { pluginId: entry.pluginId, id: entry.migration.id },
        entry.migration.doctorOnly === true ? { doctorOnly: true as const } : {},
        entry.migration.phase ? { phase: entry.migration.phase } : {},
      ),
    ),
    unresolvedPluginIds: [],
  });
  return {
    ...actual,
    listPluginDoctorStateMigrationEntries: vi.fn(() => [
      ...pluginDoctorStateMigrationEntries.entries,
      ...legacyChannelStateMigrationEntries.entries,
    ]),
    resolvePluginDoctorStateMigrationInventory: vi.fn(buildStateMigrationInventory),
  };
});

vi.mock("../plugins/doctor-contract-preparation.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/doctor-contract-preparation.js")>();
  const registry = await import("../plugins/doctor-contract-registry.js");
  return {
    ...actual,
    prepareLivePluginDoctorStateMigrationInventory: async (
      params: Parameters<typeof actual.prepareLivePluginDoctorStateMigrationInventory>[0],
    ) => registry.resolvePluginDoctorStateMigrationInventory(params),
    preparePluginDoctorSessionStoreAgentIds: async (
      params: Parameters<typeof actual.preparePluginDoctorSessionStoreAgentIds>[0],
    ) => registry.listPluginDoctorSessionStoreAgentIds(params),
    // This suite supplies callback entries directly and owns no source modules.
    preparePluginDoctorContractModules: vi.fn(async () => {}),
  };
});
