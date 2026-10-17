import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { resolveOpenClawPackageRootSync } from "../infra/openclaw-root.js";
import { resolvePluginNpmProjectDir } from "./install-paths.js";
import { writePersistedInstalledPluginIndex } from "./installed-plugin-index-store-write.js";
import { loadInstalledPluginIndex } from "./installed-plugin-index.js";
import { listManagedPlugins } from "./management-service.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import { loadPluginMetadataSnapshot } from "./plugin-metadata-snapshot.js";
import { refreshPluginRegistry } from "./plugin-registry-refresh.js";
import {
  buildPluginRegistrySnapshotReport,
  projectPluginInstallHealth,
} from "./status-snapshot.js";
import { createPluginLoadResult, createPluginRecord } from "./status.test-fixtures.js";
import {
  createColdPluginFixture,
  createColdPluginHermeticEnv,
} from "./test-helpers/cold-plugin-fixtures.js";
import { createBundleInstallFixtureFactory } from "./test-helpers/install-fixtures.js";
import { writeManagedNpmPlugin } from "./test-helpers/managed-npm-plugin.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(clearPluginMetadataLifecycleCaches);

function healthEnv(root: string, stateDir = path.join(root, "state")) {
  return {
    ...createColdPluginHermeticEnv(root),
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    OPENCLAW_DISABLE_BUNDLED_SOURCE_OVERLAYS: "1",
  };
}

function enabledConfig(...ids: string[]) {
  return { plugins: { entries: Object.fromEntries(ids.map((id) => [id, { enabled: true }])) } };
}

function writeJson(file: string, value: unknown) {
  fs.writeFileSync(file, JSON.stringify(value));
}

function patchPackage(root: string, patch: Record<string, unknown>) {
  const file = path.join(root, "package.json");
  writeJson(file, { ...JSON.parse(fs.readFileSync(file, "utf8")), ...patch });
}

function writePackage(root: string, name: string, version = "1.0.0") {
  fs.mkdirSync(root, { recursive: true });
  writeJson(path.join(root, "package.json"), { name, version });
}

function runtimeRegistry(id: string, rootDir: string, origin = "global") {
  return createPluginLoadResult({
    plugins: [
      createPluginRecord({ id, source: path.join(rootDir, "dist/index.js"), rootDir, origin }),
    ],
  });
}

function projectEmptyIndex(params: Parameters<typeof loadInstalledPluginIndex>[0]) {
  const index = loadInstalledPluginIndex(params);
  const metadata = loadPluginMetadataSnapshot({ ...params, index });
  const report = projectPluginInstallHealth(
    { plugins: [], diagnostics: [...index.diagnostics] },
    { ...params, metadata },
  );
  return { index, report };
}

function createProjectionFixture(
  params: { metadataOrigin?: "bundled" | "global"; requiredDependency?: boolean } = {},
) {
  const root = tempDirs.make("plugin-health-projection-");
  const stateDir = path.join(root, "state");
  const pluginId = "projection-fixture";
  const packageName = "@fixture/projection";
  const packageDir = writeManagedNpmPlugin({ stateDir, pluginId, packageName, version: "1.0.0" });
  if (params.requiredDependency) {
    patchPackage(packageDir, { dependencies: { "required-runtime": "1.0.0" } });
  }
  const config = enabledConfig(pluginId);
  const env = healthEnv(root, stateDir);
  const index = loadInstalledPluginIndex({
    config,
    env,
    installRecords: {
      [pluginId]: { source: "npm", spec: packageName, installPath: packageDir },
    },
  });
  const metadata = loadPluginMetadataSnapshot({
    config,
    env,
    index: {
      ...index,
      plugins: index.plugins.map((plugin) =>
        Object.assign({}, plugin, { origin: params.metadataOrigin ?? "global" }),
      ),
    },
  });
  return { pluginId, packageDir, config, env, metadata };
}

describe("plugin inventory install health", () => {
  it.skipIf(process.platform === "win32")(
    "reports a blocked linked path without missing-metadata or reinstall diagnostics",
    () => {
      const root = tempDirs.make("blocked-linked-plugin-health-");
      const pluginId = "blocked-linked-fixture";
      const pluginPath = path.join(root, "directory-alias");
      fs.mkdirSync(pluginPath);
      const fixture = createColdPluginFixture({ rootDir: pluginPath, pluginId });
      fs.chmodSync(pluginPath, 0o777);
      try {
        const config = {
          plugins: { ...enabledConfig(pluginId).plugins, load: { paths: [pluginPath] } },
        };
        const env = healthEnv(root);
        const { index, report } = projectEmptyIndex({
          config,
          env,
          installRecords: {
            [pluginId]: { source: "path", sourcePath: pluginPath, installPath: pluginPath },
          },
        });
        expect(index.plugins).toEqual([]);
        expect(index.diagnostics).toContainEqual(
          expect.objectContaining({
            pluginId,
            level: "warn",
            message: expect.stringContaining("blocked plugin candidate: world-writable path"),
          }),
        );
        expect(report.diagnostics).toEqual(index.diagnostics);
        expect(fs.existsSync(fixture.runtimeMarker)).toBe(false);
      } finally {
        fs.chmodSync(pluginPath, 0o755);
      }
    },
  );

  it.each(["sourcePath", "installPath", "unrecorded"] as const)(
    "keeps missing linked-path recovery source-specific with %s",
    (recordedPath) => {
      const root = tempDirs.make("missing-linked-plugin-health-");
      const pluginId = "missing-linked-fixture";
      const pluginPath = path.join(root, "local plugin");
      const config = enabledConfig(pluginId);
      const env = healthEnv(root);
      const installRecord: PluginInstallRecord = {
        source: "path",
        ...(recordedPath === "unrecorded" ? {} : { [recordedPath]: pluginPath }),
      };
      const { report } = projectEmptyIndex({
        config,
        env,
        installRecords: { [pluginId]: installRecord },
      });
      const diagnostic = report.diagnostics.find((entry) => entry.code === "plugin-verification");
      expect(diagnostic).toMatchObject({ pluginId, level: "error" });
      expect(diagnostic?.message).not.toContain(`openclaw plugins install ${pluginId} --force`);
      expect(diagnostic?.fixHint).toBeTruthy();
      expect(diagnostic?.fixHint).toMatch(/path|local/i);
    },
  );

  it.each([
    "empty-project",
    "missing-project-package-json",
    "missing-dependency-no-spec",
    "multi-entry-missing-dependency",
    "ancestor-dependency",
    "outside-dependency",
    "canonical-host",
    "clawhub-missing-package-json",
    "clawhub-bundle",
    "clawhub-package-selector-fallback",
    "clawhub-hoisted-host",
  ])("classifies %s consistently in status and management", async (scenario) => {
    const root = tempDirs.make("plugin-install-health-");
    const stateDir = path.join(root, "state");
    const pluginId = "install-health-fixture";
    const packageName = "@fixture/install-health";
    const clawhub = scenario.startsWith("clawhub-");
    const bundle = scenario === "clawhub-bundle";
    const clawhubPackage = "fixture/install-health";
    const packageDir = clawhub
      ? path.join(stateDir, "extensions", pluginId)
      : writeManagedNpmPlugin({ stateDir, packageName, pluginId, version: "1.0.0" });
    if (bundle) {
      fs.mkdirSync(path.join(packageDir, ".claude-plugin"), { recursive: true });
      writeJson(path.join(packageDir, ".claude-plugin/plugin.json"), {
        name: pluginId,
        version: "1.0.0",
      });
    } else {
      if (clawhub) {
        fs.mkdirSync(packageDir, { recursive: true });
        createColdPluginFixture({ rootDir: packageDir, pluginId, packageName });
      }
      writeJson(path.join(packageDir, "openclaw.plugin.json"), {
        id: pluginId,
        providers: ["fixture-provider"],
        configSchema: { type: "object" },
      });
    }
    const projectRoot = resolvePluginNpmProjectDir({
      npmDir: path.join(stateDir, "npm"),
      packageName,
    });
    const packageJsonPath = path.join(packageDir, "package.json");
    const multiEntry = scenario === "multi-entry-missing-dependency";
    const hoistedHost = scenario === "clawhub-hoisted-host";
    const host = scenario === "canonical-host" || hoistedHost;
    const healthy = host || bundle;
    const pluginIds = multiEntry ? [`${pluginId}/first`, `${pluginId}/second`] : [pluginId];
    if (multiEntry) {
      for (const entry of ["first", "second"]) {
        fs.copyFileSync(
          path.join(packageDir, "dist/index.js"),
          path.join(packageDir, `dist/${entry}.js`),
        );
      }
      patchPackage(packageDir, {
        openclaw: { extensions: ["./dist/first.js", "./dist/second.js"] },
      });
    }
    const config = enabledConfig(...pluginIds);
    const env = healthEnv(root, stateDir);
    const record: PluginInstallRecord = clawhub
      ? {
          source: "clawhub",
          clawhubPackage,
          clawhubFamily: bundle ? "bundle-plugin" : "code-plugin",
          ...(scenario !== "clawhub-package-selector-fallback"
            ? { spec: `clawhub:${clawhubPackage}@1.0.0` }
            : {}),
          installPath: packageDir,
        }
      : {
          source: "npm",
          ...(scenario === "missing-dependency-no-spec"
            ? { resolvedName: packageName }
            : { spec: packageName }),
          installPath: packageDir,
          version: "1.0.0",
        };
    const expectedInstallTarget = clawhub
      ? scenario === "clawhub-package-selector-fallback"
        ? `clawhub:${clawhubPackage}`
        : `clawhub:${clawhubPackage}@1.0.0`
      : `npm:${packageName}`;
    const index = loadInstalledPluginIndex({
      config,
      env,
      installRecords: { [pluginId]: record },
    });
    await writePersistedInstalledPluginIndex(index, { stateDir });
    if (scenario === "empty-project") {
      fs.rmSync(projectRoot, { recursive: true });
      fs.mkdirSync(projectRoot);
    } else if (scenario === "clawhub-missing-package-json") {
      fs.rmSync(packageJsonPath);
    } else if (scenario === "missing-project-package-json") {
      fs.rmSync(path.join(projectRoot, "package.json"));
    } else if (!healthy || host) {
      patchPackage(packageDir, {
        dependencies: host ? { openclaw: "*" } : { "missing-runtime": "1.0.0" },
      });
    }
    if (scenario === "ancestor-dependency" || scenario === "outside-dependency") {
      const dependency = path.join(stateDir, "npm", "node_modules", "missing-runtime");
      writePackage(dependency, "missing-runtime");
      if (scenario === "outside-dependency") {
        fs.mkdirSync(path.join(packageDir, "node_modules"), { recursive: true });
        fs.symlinkSync(
          dependency,
          path.join(packageDir, "node_modules", "missing-runtime"),
          "junction",
        );
      }
    } else if (scenario === "canonical-host") {
      const hostRoot = resolveOpenClawPackageRootSync({ moduleUrl: import.meta.url });
      if (!hostRoot) {
        throw new Error("Expected the running OpenClaw package root");
      }
      fs.mkdirSync(path.join(packageDir, "node_modules"), { recursive: true });
      fs.symlinkSync(hostRoot, path.join(packageDir, "node_modules", "openclaw"), "junction");
    } else if (hoistedHost) {
      const dependency = path.join(path.dirname(packageDir), "node_modules", "openclaw");
      writePackage(dependency, "openclaw", "2026.7.1");
    }
    clearPluginMetadataLifecycleCaches();
    const status = buildPluginRegistrySnapshotReport({ config, env });
    const management = await listManagedPlugins({
      config,
      env,
      metadata: loadPluginMetadataSnapshot({ config, env }),
      officialCatalog: { entries: [] },
    });
    for (const report of [status, management]) {
      for (const targetId of pluginIds) {
        const diagnostics = report.diagnostics.filter((entry) => entry.pluginId === targetId);
        const verification = diagnostics.filter((entry) => entry.code === "plugin-verification");
        const consent = diagnostics.filter((entry) =>
          entry.message.includes("requires capability consent"),
        );
        if (healthy) {
          expect.soft(report.plugins).toContainEqual(expect.objectContaining({ id: targetId }));
          expect.soft(verification).toEqual([]);
          if (!bundle) {
            expect.soft(consent).toContainEqual(expect.objectContaining({ level: "warn" }));
          }
        } else {
          expect.soft(verification).toContainEqual(
            expect.objectContaining({
              level: "error",
              message: expect.stringContaining("install incomplete"),
              fixHint: `Run \`openclaw plugins install ${expectedInstallTarget} --force\` to reinstall the plugin.`,
            }),
          );
          expect.soft(consent).toEqual([]);
        }
      }
    }
  });

  it.each([
    { metadataOrigin: "global", runtimeOrigin: "bundled", consent: false },
    { metadataOrigin: "bundled", runtimeOrigin: "global", consent: true },
  ] as const)(
    "uses runtime origin $runtimeOrigin for consent when metadata origin is $metadataOrigin",
    ({ metadataOrigin, runtimeOrigin, consent }) => {
      const fixture = createProjectionFixture({ metadataOrigin });
      expect(fixture.metadata.byPluginId.get(fixture.pluginId)?.origin).toBe(metadataOrigin);
      const registry = runtimeRegistry(fixture.pluginId, fixture.packageDir, runtimeOrigin);
      const report = projectPluginInstallHealth(registry, fixture);

      expect(
        report.diagnostics.filter((diagnostic) =>
          diagnostic.message.includes("requires capability consent"),
        ),
      ).toHaveLength(consent ? 1 : 0);
      expect(report.plugins[0]?.status).toBe("loaded");
    },
  );

  it("rechecks a different runtime root after caching installed dependency health", () => {
    const fixture = createProjectionFixture({ requiredDependency: true });
    const projectRoot = resolvePluginNpmProjectDir({
      npmDir: path.join(fixture.env.OPENCLAW_STATE_DIR, "npm"),
      packageName: "@fixture/projection",
    });
    const runtimeRoot = path.join(projectRoot, "alternate-runtime");
    fs.mkdirSync(runtimeRoot);
    writePackage(
      path.join(fixture.packageDir, "node_modules/required-runtime"),
      "required-runtime",
    );

    for (const { rootDir, healthy } of [
      { rootDir: fixture.packageDir, healthy: true },
      { rootDir: runtimeRoot, healthy: false },
    ]) {
      const registry = runtimeRegistry(fixture.pluginId, rootDir);
      const report = projectPluginInstallHealth(registry, fixture);

      expect(report.plugins[0]?.dependencyStatus).toMatchObject({
        requiredInstalled: healthy,
        missing: healthy ? [] : ["required-runtime"],
      });
      expect(report.plugins[0]?.status).toBe(healthy ? "loaded" : "error");
    }
  });
});

function makeTempDir() {
  return tempDirs.make("openclaw-plugin-status");
}

const setupBundleInstallFixture = createBundleInstallFixtureFactory(makeTempDir);

it.each([
  ["agent", true, "derived", ["skills"]],
  ["claude", false, "persisted", ["skills"]],
  ["cursor", true, "persisted", ["skills", "commands"]],
] as const)(
  "preserves %s bundle capabilities (enabled=%s, inventory=%s)",
  async (bundleFormat, enabled, registrySource, capabilities) => {
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

it.each([
  ["bundled-demo", undefined, undefined, false],
  ["source-external-demo", false, undefined, true],
  ["discord", undefined, "@openclaw/discord", true],
] as const)(
  "projects package-local dependencies for %s",
  (pluginId, bundledDist, packageName, missing) => {
    const tempRoot = makeTempDir();
    const bundledRoot = path.join(tempRoot, "bundled");
    const pluginRoot = path.join(bundledRoot, pluginId);
    fs.mkdirSync(pluginRoot, { recursive: true });
    createColdPluginFixture({
      rootDir: pluginRoot,
      pluginId,
      packageName: packageName ?? "@example/bundled",
      packageJson: { dependencies: { "missing-plugin-local-dependency": "1.0.0" } },
    });
    patchPackage(pluginRoot, {
      openclaw: { extensions: ["./index.cjs"], build: { bundledDist } },
    });
    const report = buildPluginRegistrySnapshotReport({
      config: enabledConfig(pluginId),
      env: createColdPluginHermeticEnv(tempRoot, { bundledPluginsDir: bundledRoot }),
    });
    const plugin = report.plugins.find((entry) => entry.id === pluginId);
    expect(plugin).toMatchObject({
      origin: "bundled",
      status: missing ? "error" : "loaded",
    });
    if (missing) {
      expect(plugin?.dependencyStatus).toMatchObject({
        requiredInstalled: false,
        missing: ["missing-plugin-local-dependency"],
      });
      expect(report.diagnostics).toContainEqual(
        expect.objectContaining({
          level: "error",
          pluginId,
          message: expect.stringContaining("required dependencies are missing"),
        }),
      );
    } else {
      expect(plugin?.dependencyStatus).toBeUndefined();
      expect(report.diagnostics).toEqual([]);
    }
  },
);
