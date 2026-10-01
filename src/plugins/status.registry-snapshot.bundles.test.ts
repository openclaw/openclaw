// Covers detected bundle capabilities in derived and persisted plugin inventory.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import { refreshPluginRegistry } from "./plugin-registry-refresh.js";
import { buildPluginRegistrySnapshotReport } from "./status.js";
import {
  createColdPluginFixture,
  createColdPluginHermeticEnv,
} from "./test-helpers/cold-plugin-fixtures.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";
import { createBundleInstallFixtureFactory } from "./test-helpers/install-fixtures.js";

const tempDirs: string[] = [];

function makeTempDir() {
  return makeTrackedTempDir("openclaw-plugin-status", tempDirs);
}

const setupBundleInstallFixture = createBundleInstallFixtureFactory(makeTempDir);

afterEach(() => {
  clearPluginMetadataLifecycleCaches();
  cleanupTrackedTempDirs(tempDirs);
});

describe("buildPluginRegistrySnapshotReport", () => {
  it.each([
    {
      bundleFormat: "agent",
      enabled: true,
      registrySource: "derived",
      capabilities: ["skills"],
    },
    {
      bundleFormat: "claude",
      enabled: false,
      registrySource: "persisted",
      capabilities: ["skills"],
    },
    {
      bundleFormat: "cursor",
      enabled: true,
      registrySource: "persisted",
      capabilities: ["skills", "commands"],
    },
  ] as const)(
    "preserves $bundleFormat bundle capabilities in $registrySource inventory (enabled=$enabled)",
    async ({ bundleFormat, enabled, registrySource, capabilities }) => {
      const name = `${bundleFormat}-capability-fixture`;
      const { pluginDir, extensionsDir } = setupBundleInstallFixture({ bundleFormat, name });
      const stateDir = path.dirname(extensionsDir);
      const workspaceDir = path.dirname(stateDir);
      const params = {
        config: {
          plugins: {
            load: { paths: [pluginDir] },
            entries: { [name]: { enabled } },
          },
        },
        workspaceDir,
        env: {
          ...createColdPluginHermeticEnv(workspaceDir, { bundledPluginsDir: makeTempDir() }),
          OPENCLAW_STATE_DIR: stateDir,
        },
      };
      if (registrySource === "persisted") {
        await refreshPluginRegistry({ ...params, stateDir, reason: "manual" });
      }

      const report = buildPluginRegistrySnapshotReport(params);

      expect(report.plugins.find((plugin) => plugin.id === name)).toMatchObject({
        format: "bundle",
        bundleFormat,
        bundleCapabilities: capabilities,
        enabled,
      });
      expect(report.registrySource).toBe(registrySource);
    },
  );
});

describe("bundled dependency health", () => {
  it.each([
    { pluginId: "bundled-demo", bundledDist: undefined, packageName: undefined, missing: false },
    { pluginId: "source-external-demo", bundledDist: false, packageName: undefined, missing: true },
    {
      pluginId: "discord",
      bundledDist: undefined,
      packageName: "@openclaw/discord",
      missing: true,
    },
  ] as const)("projects package-local dependencies for $pluginId", (identity) => {
    const tempRoot = makeTempDir();
    const bundledRoot = path.join(tempRoot, "bundled");
    const pluginRoot = path.join(bundledRoot, identity.pluginId);
    fs.mkdirSync(pluginRoot, { recursive: true });
    createColdPluginFixture({
      rootDir: pluginRoot,
      pluginId: identity.pluginId,
      packageName: identity.packageName,
    });
    fs.writeFileSync(
      path.join(pluginRoot, "package.json"),
      JSON.stringify({
        name: identity.packageName ?? "@example/bundled",
        version: "1.0.0",
        dependencies: { "missing-plugin-local-dependency": "1.0.0" },
        openclaw: { extensions: ["./index.cjs"], build: { bundledDist: identity.bundledDist } },
      }),
    );
    const report = buildPluginRegistrySnapshotReport({
      config: { plugins: { entries: { [identity.pluginId]: { enabled: true } } } },
      env: createColdPluginHermeticEnv(tempRoot, { bundledPluginsDir: bundledRoot }),
    });
    const plugin = report.plugins.find((entry) => entry.id === identity.pluginId);
    expect(plugin).toMatchObject({
      origin: "bundled",
      status: identity.missing ? "error" : "loaded",
    });
    if (identity.missing) {
      expect(plugin?.dependencyStatus).toMatchObject({
        requiredInstalled: false,
        missing: ["missing-plugin-local-dependency"],
      });
      expect(report.diagnostics).toContainEqual(
        expect.objectContaining({
          level: "error",
          pluginId: identity.pluginId,
          message: expect.stringContaining("required dependencies are missing"),
        }),
      );
    } else {
      expect(plugin?.dependencyStatus).toBeUndefined();
      expect(report.diagnostics).toEqual([]);
    }
  });
});
