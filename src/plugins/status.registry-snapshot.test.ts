import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearPluginDiscoveryCache } from "./discovery.js";
import { writePersistedInstalledPluginIndex } from "./installed-plugin-index-store.js";
import { loadInstalledPluginIndex } from "./installed-plugin-index.js";
import { clearPluginManifestRegistryCache } from "./manifest-registry.js";
import { buildPluginRegistrySnapshotReport } from "./status.js";

const tempDirs: string[] = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-plugin-status-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  clearPluginDiscoveryCache();
  clearPluginManifestRegistryCache();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("buildPluginRegistrySnapshotReport", () => {
  it("reports list metadata from the installed index without importing plugin runtime", () => {
    const pluginDir = makeTempDir();
    const runtimeMarker = path.join(pluginDir, "runtime-loaded.txt");
    fs.writeFileSync(
      path.join(pluginDir, "package.json"),
      JSON.stringify({
        name: "@example/openclaw-indexed-demo",
        version: "9.8.7",
        openclaw: { extensions: ["./index.cjs"] },
      }),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(pluginDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: "indexed-demo",
        name: "Indexed Demo",
        description: "Manifest-backed list metadata",
        version: "1.2.3",
        providers: ["indexed-provider"],
        commandAliases: [{ name: "indexed-demo" }],
        configSchema: {
          type: "object",
          additionalProperties: false,
          properties: {},
        },
      }),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(pluginDir, "index.cjs"),
      `require("node:fs").writeFileSync(${JSON.stringify(runtimeMarker)}, "loaded", "utf-8");\nmodule.exports = { id: "indexed-demo", register() {} };\n`,
      "utf-8",
    );

    const report = buildPluginRegistrySnapshotReport({
      config: {
        plugins: {
          load: { paths: [pluginDir] },
        },
      },
    });

    const plugin = report.plugins.find((entry) => entry.id === "indexed-demo");
    expect(plugin).toMatchObject({
      id: "indexed-demo",
      name: "Indexed Demo",
      description: "Manifest-backed list metadata",
      version: "9.8.7",
      format: "openclaw",
      providerIds: ["indexed-provider"],
      commands: ["indexed-demo"],
      source: fs.realpathSync(path.join(pluginDir, "index.cjs")),
      status: "loaded",
    });
    expect(fs.existsSync(runtimeMarker)).toBe(false);
  });

  it("reports persisted indexed metadata without reopening stale manifest roots", async () => {
    const pluginDir = makeTempDir();
    const stateDir = makeTempDir();
    const env = {
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_VERSION: "2026.4.25",
      VITEST: "true",
    };
    fs.writeFileSync(
      path.join(pluginDir, "package.json"),
      JSON.stringify({
        name: "@example/openclaw-stale-indexed-demo",
        version: "4.5.6",
        openclaw: { extensions: ["./index.cjs"] },
      }),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(pluginDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: "stale-indexed-demo",
        name: "Stale Indexed Demo",
        description: "Persisted list metadata",
        version: "1.0.0",
        providers: ["stale-provider"],
        commandAliases: [{ name: "stale-command" }],
      }),
      "utf-8",
    );
    fs.writeFileSync(path.join(pluginDir, "index.cjs"), "module.exports = {};\n", "utf-8");

    const index = loadInstalledPluginIndex({
      config: {},
      env,
      candidates: [
        {
          idHint: "stale-indexed-demo",
          source: path.join(pluginDir, "index.cjs"),
          rootDir: pluginDir,
          origin: "global",
          packageName: "@example/openclaw-stale-indexed-demo",
          packageVersion: "4.5.6",
          packageDir: pluginDir,
        },
      ],
    });
    await writePersistedInstalledPluginIndex(index, { stateDir });
    fs.rmSync(pluginDir, { recursive: true, force: true });

    const report = buildPluginRegistrySnapshotReport({
      config: {},
      env,
    });

    expect(report.registrySource).toBe("persisted");
    expect(report.plugins).toEqual([
      expect.objectContaining({
        id: "stale-indexed-demo",
        name: "Stale Indexed Demo",
        description: "Persisted list metadata",
        version: "4.5.6",
        providerIds: ["stale-provider"],
        commands: ["stale-command"],
      }),
    ]);
  });
});
