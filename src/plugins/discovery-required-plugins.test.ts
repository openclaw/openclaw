import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { discoverOpenClawPlugins } from "./discovery.js";
import { loadPluginManifestRegistryCore } from "./manifest-registry.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function writePlugin(root: string, id: string, requiresPlugins?: string[]): string {
  fs.mkdirSync(root, { recursive: true, mode: 0o755 });
  fs.writeFileSync(
    path.join(root, "openclaw.plugin.json"),
    JSON.stringify({ id, requiresPlugins, configSchema: { type: "object" } }),
  );
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "@test/plugin", openclaw: { extensions: ["./index.js"] } }),
  );
  const entry = path.join(root, "index.js");
  fs.writeFileSync(entry, "export default function () {}");
  return entry;
}

function discoveryEnv(stateDir: string): NodeJS.ProcessEnv {
  return { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" };
}

describe("required plugin discovery diagnostics", () => {
  it.each([
    { installedId: "Core-Mixed", requiredId: "core-mixed", explicitFile: false },
    { installedId: "core-mixed", requiredId: "CORE-MIXED", explicitFile: false },
    { installedId: "Core-Mixed", requiredId: "core-mixed", explicitFile: true },
    { installedId: "core-mixed", requiredId: "CORE-MIXED", explicitFile: true },
  ])(
    "matches $installedId -> $requiredId (explicit file: $explicitFile) without rewriting declared ids",
    ({ installedId, requiredId, explicitFile }) => {
      const stateDir = tempDirs.make("openclaw-required-plugins-");
      const env = discoveryEnv(stateDir);
      const coreEntry = writePlugin(
        path.join(stateDir, explicitFile ? "configured" : "extensions", "core"),
        installedId,
      );
      writePlugin(path.join(stateDir, "extensions", "addon"), "Addon", [requiredId]);
      const extraPaths = explicitFile ? [coreEntry] : [];

      withPluginCache(createPluginCache(), () => {
        const discovery = discoverOpenClawPlugins({ env, extraPaths });
        expect(discovery.candidates.map((candidate) => candidate.idHint).toSorted()).toEqual(
          [explicitFile ? "index" : installedId, "Addon"].toSorted(),
        );
        expect(discovery.diagnostics).toEqual([]);
        const registry = loadPluginManifestRegistryCore({
          env,
          config: { plugins: { load: { paths: extraPaths } } },
          discovery,
          installRecords: {},
        });
        expect(registry.plugins.map((plugin) => plugin.id).toSorted()).toEqual(
          [installedId, "Addon"].toSorted(),
        );
        expect(registry.diagnostics).toEqual([]);
      });
    },
  );

  it("keeps one actionable warning with the declared spelling for missing aliases", () => {
    const stateDir = tempDirs.make("openclaw-required-plugins-");
    const pluginDir = path.join(stateDir, "extensions", "addon");
    writePlugin(pluginDir, "Addon", ["Missing-Core", "missing-core"]);

    const result = withPluginCache(createPluginCache(), () =>
      discoverOpenClawPlugins({ env: discoveryEnv(stateDir) }),
    );

    expect(result.candidates.map((candidate) => candidate.idHint)).toEqual(["Addon"]);
    expect(result.diagnostics).toEqual([
      {
        level: "warn",
        pluginId: "Addon",
        source: path.join(pluginDir, "openclaw.plugin.json"),
        message: 'plugin "Addon" requires plugin "Missing-Core"; install "Missing-Core" to use it',
      },
    ]);
  });
});
