import path from "node:path";
import type { InstalledPluginIndex } from "./installed-plugin-index.js";
import { createIndexFixture } from "./test-helpers/installed-plugin-index-fixture.js";

export function createIndex(rootDir: string): InstalledPluginIndex {
  return createIndexFixture({
    hostContractVersion: "2026.4.25",
    compatRegistryVersion: "compat-v1",
    policyHash: "policy-v1",
    generatedAtMs: 1777118400000,
    plugins: [
      {
        pluginId: "installed",
        manifestPath: path.join(rootDir, "openclaw.plugin.json"),
        manifestHash: "manifest-hash",
        source: path.join(rootDir, "index.ts"),
        rootDir,
        origin: "global",
        enabled: true,
        startup: {
          sidecar: false,
          memory: false,
          agentHarnesses: [],
        },
        compat: [],
      },
    ],
  });
}
