import type { InstalledPluginIndex } from "../installed-plugin-index-types.js";

export function createIndexFixture(overrides: Partial<InstalledPluginIndex>): InstalledPluginIndex {
  return {
    version: 1,
    hostContractVersion: "test",
    compatRegistryVersion: "test",
    migrationVersion: 1,
    policyHash: "test",
    generatedAtMs: 1,
    installRecords: {},
    plugins: [],
    diagnostics: [],
    ...overrides,
  };
}
