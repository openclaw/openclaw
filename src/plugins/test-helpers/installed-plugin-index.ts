import fs from "node:fs";
import path from "node:path";
import type { PluginInstallRecord } from "../../config/types.plugins.js";
import type { PluginCandidate } from "../discovery.js";
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
  await refreshPersistedInstalledPluginIndex({
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

export function createInstalledPluginIndexCandidate(
  rootDir: string,
  options: { id?: string; configPaths?: readonly string[] } = {},
): PluginCandidate {
  const id = options.id ?? "demo";
  fs.writeFileSync(
    path.join(rootDir, "index.ts"),
    "throw new Error('runtime entry should not load while persisting installed plugin index');\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(rootDir, "openclaw.plugin.json"),
    JSON.stringify({
      id,
      name: id === "demo" ? "Demo" : "Next Demo",
      configSchema: { type: "object" },
      providers: [id],
      ...(options.configPaths ? { activation: { onConfigPaths: options.configPaths } } : {}),
    }),
    "utf8",
  );
  return {
    idHint: id,
    source: path.join(rootDir, "index.ts"),
    rootDir,
    origin: "global",
  };
}
