import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { resolveOpenClawPackageRootSync } from "../infra/openclaw-root.js";
import { resolvePluginNpmProjectDir } from "./install-paths.js";
import { writePersistedInstalledPluginIndexSync } from "./installed-plugin-index-store-write.js";
import { loadInstalledPluginIndex } from "./installed-plugin-index.js";
import { listManagedPlugins } from "./management-service.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import { loadPluginMetadataSnapshot } from "./plugin-metadata-snapshot.js";
import type { PluginDependencyHealthRegistry } from "./status-dependencies-core.js";
import {
  buildPluginRegistrySnapshotReport,
  projectPluginInstallHealth,
} from "./status-snapshot.js";
import {
  createColdPluginFixture,
  createColdPluginHermeticEnv,
} from "./test-helpers/cold-plugin-fixtures.js";
import { writeManagedNpmPlugin } from "./test-helpers/managed-npm-plugin.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(clearPluginMetadataLifecycleCaches);

function createProjectionFixture(
  params: { metadataOrigin?: "bundled" | "global"; requiredDependency?: boolean } = {},
) {
  const root = tempDirs.make("plugin-health-projection-");
  const stateDir = path.join(root, "state");
  const pluginId = "projection-fixture";
  const packageName = "@fixture/projection";
  const packageDir = writeManagedNpmPlugin({ stateDir, pluginId, packageName, version: "1.0.0" });
  if (params.requiredDependency) {
    const packageJsonPath = path.join(packageDir, "package.json");
    const manifest = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
    fs.writeFileSync(
      packageJsonPath,
      JSON.stringify({ ...manifest, dependencies: { "required-runtime": "1.0.0" } }),
    );
  }
  const config = { plugins: { entries: { [pluginId]: { enabled: true } } } };
  const env = {
    ...createColdPluginHermeticEnv(root),
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    OPENCLAW_DISABLE_BUNDLED_SOURCE_OVERLAYS: "1",
  };
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
  it.each([
    "empty-project",
    "missing-package-json",
    "missing-project-package-json",
    "missing-dependency",
    "missing-dependency-no-spec",
    "multi-entry-missing-dependency",
    "ancestor-dependency",
    "outside-dependency",
    "canonical-host",
    "consent-pending",
    "clawhub-missing-dependency",
    "clawhub-missing-package-json",
    "clawhub-bundle",
    "clawhub-package-selector-fallback",
    "clawhub-copied-host",
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
      fs.writeFileSync(
        path.join(packageDir, ".claude-plugin", "plugin.json"),
        JSON.stringify({ name: pluginId, version: "1.0.0" }),
      );
    } else {
      if (clawhub) {
        fs.mkdirSync(packageDir, { recursive: true });
        createColdPluginFixture({ rootDir: packageDir, pluginId, packageName });
      }
      fs.writeFileSync(
        path.join(packageDir, "openclaw.plugin.json"),
        JSON.stringify({
          id: pluginId,
          providers: ["fixture-provider"],
          configSchema: { type: "object" },
        }),
      );
    }
    const projectRoot = resolvePluginNpmProjectDir({
      npmDir: path.join(stateDir, "npm"),
      packageName,
    });
    const packageJsonPath = path.join(packageDir, "package.json");
    const multiEntry = scenario === "multi-entry-missing-dependency";
    const copiedHost = scenario === "clawhub-copied-host";
    const hoistedHost = scenario === "clawhub-hoisted-host";
    const host = scenario === "canonical-host" || copiedHost || hoistedHost;
    const healthy = scenario === "consent-pending" || host || bundle;
    const pluginIds = multiEntry ? [`${pluginId}/first`, `${pluginId}/second`] : [pluginId];
    if (multiEntry) {
      for (const entry of ["first", "second"]) {
        fs.copyFileSync(
          path.join(packageDir, "dist/index.js"),
          path.join(packageDir, `dist/${entry}.js`),
        );
      }
      const manifest = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
      fs.writeFileSync(
        packageJsonPath,
        JSON.stringify({
          ...manifest,
          openclaw: { extensions: ["./dist/first.js", "./dist/second.js"] },
        }),
      );
    }
    const config = {
      plugins: { entries: Object.fromEntries(pluginIds.map((id) => [id, { enabled: true }])) },
    };
    const env = {
      ...createColdPluginHermeticEnv(root),
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_DISABLE_BUNDLED_SOURCE_OVERLAYS: "1",
    };
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
      : packageName;
    const index = loadInstalledPluginIndex({
      config,
      env,
      installRecords: { [pluginId]: record },
    });
    writePersistedInstalledPluginIndexSync(index, { stateDir });
    if (scenario === "empty-project") {
      fs.rmSync(projectRoot, { recursive: true });
      fs.mkdirSync(projectRoot);
    } else if (scenario === "missing-package-json" || scenario === "clawhub-missing-package-json") {
      fs.rmSync(packageJsonPath);
    } else if (scenario === "missing-project-package-json") {
      fs.rmSync(path.join(projectRoot, "package.json"));
    } else if (!healthy || host) {
      const manifest = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
      fs.writeFileSync(
        packageJsonPath,
        JSON.stringify({
          ...manifest,
          dependencies: host ? { openclaw: "*" } : { "missing-runtime": "1.0.0" },
        }),
      );
    }
    if (scenario === "ancestor-dependency" || scenario === "outside-dependency") {
      const dependency = path.join(stateDir, "npm", "node_modules", "missing-runtime");
      fs.mkdirSync(dependency, { recursive: true });
      fs.writeFileSync(
        path.join(dependency, "package.json"),
        JSON.stringify({ name: "missing-runtime", version: "1.0.0" }),
      );
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
    } else if (copiedHost || hoistedHost) {
      const dependency = path.join(
        hoistedHost ? path.dirname(packageDir) : packageDir,
        "node_modules",
        "openclaw",
      );
      fs.mkdirSync(dependency, { recursive: true });
      fs.writeFileSync(
        path.join(dependency, "package.json"),
        JSON.stringify({ name: "openclaw", version: "2026.7.1" }),
      );
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
        if (healthy) {
          expect.soft(report.plugins).toContainEqual(expect.objectContaining({ id: targetId }));
          if (!bundle) {
            expect.soft(report.diagnostics).toContainEqual(
              expect.objectContaining({
                pluginId: targetId,
                level: "warn",
                message: expect.stringContaining("requires capability consent"),
              }),
            );
          }
          expect
            .soft(report.diagnostics)
            .not.toContainEqual(
              expect.objectContaining({ pluginId: targetId, code: "plugin-verification" }),
            );
        } else {
          expect.soft(report.diagnostics).toContainEqual(
            expect.objectContaining({
              pluginId: targetId,
              level: "error",
              code: "plugin-verification",
              message: expect.stringContaining("install incomplete"),
              fixHint: `Run \`openclaw plugins install ${expectedInstallTarget} --force\` to reinstall the plugin.`,
            }),
          );
          expect.soft(report.diagnostics).not.toContainEqual(
            expect.objectContaining({
              pluginId: targetId,
              message: expect.stringContaining("requires capability consent"),
            }),
          );
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
      const registry: PluginDependencyHealthRegistry = {
        plugins: [
          {
            id: fixture.pluginId,
            source: path.join(fixture.packageDir, "dist/index.js"),
            rootDir: fixture.packageDir,
            enabled: true,
            status: "loaded",
            origin: runtimeOrigin,
          },
        ],
        diagnostics: [],
      };
      const report = projectPluginInstallHealth(registry, fixture);

      expect(
        report.diagnostics.filter((diagnostic) =>
          diagnostic.message.includes("requires capability consent"),
        ),
      ).toHaveLength(consent ? 1 : 0);
      expect(report.plugins[0]?.status).toBe("loaded");
    },
  );

  it.each([true, false])(
    "rechecks a different runtime root after caching installed dependency health: %s",
    (initiallyHealthy) => {
      const fixture = createProjectionFixture({ requiredDependency: true });
      const projectRoot = resolvePluginNpmProjectDir({
        npmDir: path.join(fixture.env.OPENCLAW_STATE_DIR, "npm"),
        packageName: "@fixture/projection",
      });
      const runtimeRoot = path.join(projectRoot, "alternate-runtime");
      fs.mkdirSync(runtimeRoot);
      const dependency = path.join(
        initiallyHealthy ? fixture.packageDir : runtimeRoot,
        "node_modules",
        "required-runtime",
      );
      fs.mkdirSync(dependency, { recursive: true });
      fs.writeFileSync(
        path.join(dependency, "package.json"),
        JSON.stringify({ name: "required-runtime", version: "1.0.0" }),
      );

      for (const { rootDir, healthy } of [
        { rootDir: fixture.packageDir, healthy: initiallyHealthy },
        { rootDir: runtimeRoot, healthy: !initiallyHealthy },
      ]) {
        const registry: PluginDependencyHealthRegistry = {
          plugins: [
            {
              id: fixture.pluginId,
              source: path.join(rootDir, "dist/index.js"),
              rootDir,
              enabled: true,
              status: "loaded",
              origin: "global",
            },
          ],
          diagnostics: [],
        };
        const report = projectPluginInstallHealth(registry, fixture);

        expect(report.plugins[0]?.dependencyStatus).toMatchObject({
          requiredInstalled: healthy,
          missing: healthy ? [] : ["required-runtime"],
        });
        expect(report.plugins[0]?.status).toBe(healthy ? "loaded" : "error");
      }
    },
  );
});
