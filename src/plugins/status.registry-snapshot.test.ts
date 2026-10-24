import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { buildPluginCapabilitySummary, computeDeclaredSurfaceHash } from "./capability-summary.js";
import { getCurrentPluginMetadataSnapshot } from "./current-plugin-metadata-snapshot.js";
import { setCurrentPluginMetadataSnapshot } from "./current-plugin-metadata.test-support.js";
import { writePersistedInstalledPluginIndex } from "./installed-plugin-index-store-write.js";
import { readPersistedInstalledPluginIndex } from "./installed-plugin-index-store.js";
import { loadInstalledPluginIndex } from "./installed-plugin-index.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import { loadPluginMetadataSnapshot } from "./plugin-metadata-snapshot.js";
import { refreshPluginRegistry } from "./plugin-registry-refresh.js";
import {
  withPluginDiagnosticsReport,
  buildPluginRegistrySnapshotReport,
  buildPluginSnapshotReport,
} from "./status.js";
import {
  createColdPluginConfig,
  createColdPluginFixture,
  createColdPluginHermeticEnv,
  isColdPluginRuntimeLoaded,
} from "./test-helpers/cold-plugin-fixtures.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";
import { writeManagedNpmPlugin } from "./test-helpers/managed-npm-plugin.js";

const tempDirs: string[] = [];

function makeTempDir() {
  return makeTrackedTempDir("openclaw-plugin-status", tempDirs);
}

function createStatusEnv(disableBundled = true) {
  const rootDir = fs.realpathSync(makeTempDir());
  const stateDir = path.join(rootDir, "state");
  const env = {
    ...createColdPluginHermeticEnv(rootDir, { bundledPluginsDir: makeTempDir() }),
    ...(disableBundled ? { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" } : {}),
    OPENCLAW_STATE_DIR: stateDir,
  };
  return { rootDir, stateDir, env };
}

function createPluginAt(root: string, pluginId: string) {
  const rootDir = path.join(root, "extensions", pluginId);
  fs.mkdirSync(rootDir, { recursive: true });
  return createColdPluginFixture({ rootDir, pluginId });
}

function expectPluginIds(
  plugins: ReadonlyArray<{ id?: string; pluginId?: string }>,
  ...ids: string[]
) {
  expect(
    plugins
      .map((plugin) => plugin.id ?? plugin.pluginId)
      .toSorted((left, right) => String(left).localeCompare(String(right))),
  ).toEqual(ids.toSorted((left, right) => left.localeCompare(right)));
}

function createWorkspaceFixture() {
  const params = createStatusEnv();
  const mainWorkspace = path.join(params.rootDir, "main-workspace");
  const gadgetWorkspace = path.join(params.rootDir, "gadget-workspace");
  const global = createPluginAt(params.stateDir, "global-plugin");
  const main = createPluginAt(path.join(mainWorkspace, ".openclaw"), "main-plugin");
  const gadget = createPluginAt(path.join(gadgetWorkspace, ".openclaw"), "gadget-plugin");
  const config = {
    agents: {
      ownership: "explicit" as const,
      defaults: { workspace: path.join(params.rootDir, "unowned-default-workspace") },
      entries: { main: { workspace: mainWorkspace }, gadget: { workspace: gadgetWorkspace } },
    },
    plugins: {
      allow: [global.pluginId, main.pluginId, gadget.pluginId],
      entries: Object.fromEntries(
        [global, main, gadget].map(({ pluginId }) => [pluginId, { enabled: true }]),
      ),
    },
  };
  return { ...params, mainWorkspace, global, main, gadget, config };
}

afterEach(() => {
  vi.restoreAllMocks();
  clearPluginMetadataLifecycleCaches();
  cleanupTrackedTempDirs(tempDirs);
});

describe("buildPluginRegistrySnapshotReport", () => {
  it("reports shared-only inventory when an explicit roster has no system owner", async () => {
    const { config, env, mainWorkspace, global } = createWorkspaceFixture();
    const scoped = loadPluginMetadataSnapshot({ config, env, workspaceDir: mainWorkspace });
    setCurrentPluginMetadataSnapshot(scoped, { config, env, workspaceDir: mainWorkspace });
    const assertReport = (report: ReturnType<typeof buildPluginSnapshotReport>) => {
      expect(report.workspaceDir).toBeUndefined();
      expectPluginIds(report.plugins, global.pluginId);
      expect(report.diagnostics).toContainEqual(
        expect.objectContaining({ level: "warn", code: "workspace-scope-omitted" }),
      );
    };
    assertReport(buildPluginRegistrySnapshotReport({ config, env }));
    assertReport(buildPluginSnapshotReport({ config, env }));
    await withPluginDiagnosticsReport({ config, env }, assertReport);
  });

  it("self-heals a shared-only registry after a system owner is configured", async () => {
    const { config, env, stateDir, mainWorkspace, global, main, gadget } = createWorkspaceFixture();
    const partial = await refreshPluginRegistry({ config, env, reason: "manual", stateDir });
    expectPluginIds(partial.plugins, global.pluginId);
    expect(partial.diagnostics).toContainEqual(
      expect.objectContaining({ code: "workspace-scope-omitted" }),
    );

    const ownedConfig = {
      ...config,
      agents: {
        ...config.agents,
        defaults: { systemAgent: { agentId: "gadget" } },
      },
    };
    for (let refresh = 0; refresh < 2; refresh++) {
      const refreshed = await refreshPluginRegistry({
        config: ownedConfig,
        env,
        stateDir,
        policyPluginIds: [global.pluginId],
        reason: "policy-changed",
      });
      expectPluginIds(refreshed.plugins, gadget.pluginId, global.pluginId);
      expect(refreshed.diagnostics).not.toContainEqual(
        expect.objectContaining({ code: "workspace-scope-omitted" }),
      );
    }

    const explicitMainReport = buildPluginRegistrySnapshotReport({
      config: ownedConfig,
      env,
      workspaceDir: mainWorkspace,
    });
    expectPluginIds(explicitMainReport.plugins, global.pluginId, main.pluginId);
    const persisted = await readPersistedInstalledPluginIndex({ stateDir });
    expectPluginIds(persisted?.plugins ?? [], gadget.pluginId, global.pluginId);
  });

  it.each([
    { consent: "stale", warns: true },
    { consent: "current", warns: false },
  ] as const)(
    "projects capability-consent diagnostics for $consent acceptance",
    async ({ consent, warns }) => {
      const { stateDir, env } = createStatusEnv();
      const fixture = createPluginAt(stateDir, "consent-demo");
      const config = {
        plugins: { entries: { [fixture.pluginId]: { enabled: true } } },
      };
      const { declared } = buildPluginCapabilitySummary({
        manifest: { channels: [fixture.channelId], providers: [fixture.providerId] },
        origin: "global",
      });
      const acceptedSurface = consent === "stale" ? { ...declared, providers: [] } : declared;
      const installRecord: PluginInstallRecord = {
        source: "path",
        installPath: fixture.rootDir,
        integrity: "sha256-consent-fixture",
        acceptedSurface,
        acceptedSurfaceHash: computeDeclaredSurfaceHash(acceptedSurface),
        acceptedSurfaceIntegrity: "sha256-consent-fixture",
      };
      const index = loadInstalledPluginIndex({
        config,
        env,
        installRecords: { [fixture.pluginId]: installRecord },
      });
      await writePersistedInstalledPluginIndex(index, { stateDir });

      for (const buildReport of [buildPluginRegistrySnapshotReport, buildPluginSnapshotReport]) {
        const diagnostics = buildReport({ config, env }).diagnostics.filter(
          (diagnostic) =>
            diagnostic.pluginId === fixture.pluginId &&
            diagnostic.message.includes("requires capability consent"),
        );
        expect(diagnostics).toHaveLength(warns ? 1 : 0);
        if (warns) {
          expect(diagnostics[0]).toEqual({
            level: "warn",
            pluginId: fixture.pluginId,
            message: expect.stringContaining("--accept-capabilities"),
          });
        }
      }
      expect(isColdPluginRuntimeLoaded(fixture)).toBe(false);
    },
  );

  it("keeps recovered managed npm plugins visible when the persisted registry is stale", async () => {
    const { stateDir, env } = createStatusEnv();
    const config = { plugins: { entries: { whatsapp: { enabled: true } } } };
    const whatsappDir = writeManagedNpmPlugin({
      stateDir,
      packageName: "@openclaw/whatsapp",
      pluginId: "whatsapp",
      version: "2026.5.2",
      name: "WhatsApp",
    });
    const staleIndex = loadInstalledPluginIndex({ config, env, installRecords: {} });
    expect(staleIndex.plugins.map((plugin) => plugin.pluginId)).not.toContain("whatsapp");
    await writePersistedInstalledPluginIndex(staleIndex, { stateDir });

    const report = buildPluginRegistrySnapshotReport({ config, env });

    expect(report.registrySource).toBe("derived");
    expect(report.registryDiagnostics).toContainEqual(
      expect.objectContaining({ code: "persisted-registry-stale-source" }),
    );
    expect(report.plugins.find((plugin) => plugin.id === "whatsapp")).toMatchObject({
      id: "whatsapp",
      name: "WhatsApp",
      source: fs.realpathSync(path.join(whatsappDir, "dist", "index.js")),
      status: "loaded",
    });
  });

  it("reuses prepared list metadata with a persisted registry and omitted workspace", async () => {
    const { rootDir: tempRoot, stateDir, env } = createStatusEnv(false);
    const fixture = createColdPluginFixture({
      rootDir: tempRoot,
      pluginId: "indexed-demo",
      packageName: "@example/openclaw-indexed-demo",
      packageVersion: "9.8.7",
      manifest: {
        version: "1.2.3",
        contracts: { tools: ["indexed_echo", "indexed_search", "indexed_echo"] },
      },
    });

    const config = {
      agents: { ownership: "explicit" as const, entries: { first: {}, second: {} } },
      plugins: {
        load: { paths: [fixture.rootDir] },
        entries: { [fixture.pluginId]: { enabled: false } },
      },
    };
    const params = { config, env };
    const index = loadInstalledPluginIndex(params);
    await writePersistedInstalledPluginIndex(index, { stateDir });
    const open = vi.spyOn(fs, "openSync");
    const report = buildPluginRegistrySnapshotReport(params);
    const manifestOpens = open.mock.calls.filter(
      ([file]) => file === path.join(fixture.rootDir, "openclaw.plugin.json"),
    ).length;
    open.mockRestore();

    expect(report.plugins).toMatchObject([
      {
        version: "9.8.7",
        toolNames: ["indexed_echo", "indexed_search"],
        source: fs.realpathSync(fixture.runtimeSource),
        enabled: false,
        status: "disabled",
      },
    ]);
    expect(report).toMatchObject({
      workspaceDir: undefined,
      workspaceScope: "omitted",
      registrySource: "persisted",
      registryDiagnostics: [],
      diagnostics: [{ level: "warn", code: "workspace-scope-omitted" }],
    });
    expect(isColdPluginRuntimeLoaded(fixture)).toBe(false);
    expect(getCurrentPluginMetadataSnapshot(params)).toBeUndefined();
    // Discovery, validation, index hashing, and status share one checked manifest read.
    expect(manifestOpens).toBe(1);
  });

  it.each([false, true])(
    "reuses current metadata without a recorded source (diagnostics: %s)",
    (hasDiagnostics) => {
      const { rootDir, env } = createStatusEnv(false);
      const fixture = createColdPluginFixture({
        rootDir,
        pluginId: "current-demo",
      });
      const config = createColdPluginConfig(rootDir, fixture.pluginId);
      const params = { config, env, workspaceDir: rootDir };
      const coldReport = buildPluginRegistrySnapshotReport(params);
      const { registrySource: _registrySource, ...current } = loadPluginMetadataSnapshot(params);
      if (!hasDiagnostics) {
        current.registryDiagnostics = [];
      }
      setCurrentPluginMetadataSnapshot(current, params);
      const open = vi.spyOn(fs, "openSync");

      const report = buildPluginRegistrySnapshotReport(params);
      const metadataOpens = open.mock.calls.filter(
        ([file]) =>
          file === path.join(rootDir, "openclaw.plugin.json") ||
          file === path.join(rootDir, "package.json"),
      );
      open.mockRestore();

      expect(report.plugins).toEqual(coldReport.plugins);
      expect(report).toMatchObject({
        registrySource: hasDiagnostics ? "derived" : "provided",
        registryDiagnostics: hasDiagnostics
          ? [expect.objectContaining({ level: "info", code: "persisted-registry-missing" })]
          : [],
        diagnostics: [],
      });
      expect(metadataOpens).toEqual([]);
      expect(getCurrentPluginMetadataSnapshot(params)).toBe(current);
      expect(isColdPluginRuntimeLoaded(fixture)).toBe(false);
    },
  );

  it.each([true, false])(
    "reports dependency health without importing runtime (enabled=%s)",
    (enabled) => {
      const rootDir = makeTempDir();
      const dependencyDir = path.join(rootDir, "node_modules", "present-required");
      fs.mkdirSync(dependencyDir, { recursive: true });
      fs.writeFileSync(
        path.join(dependencyDir, "package.json"),
        JSON.stringify({ name: "present-required", version: "1.0.0" }),
      );
      const fixture = createColdPluginFixture({
        rootDir,
        pluginId: "dependency-demo",
        packageJson: {
          dependencies: { "missing-required": "1.0.0", "present-required": "1.0.0" },
          optionalDependencies: { "missing-optional": "1.0.0" },
        },
        manifest: { contracts: { tools: ["disabled_demo_tool"] } },
      });
      const report = buildPluginRegistrySnapshotReport({
        config: {
          plugins: {
            load: { paths: [fixture.rootDir] },
            ...(enabled ? {} : { entries: { [fixture.pluginId]: { enabled: false } } }),
          },
        },
      });
      const plugin = report.plugins.find((entry) => entry.id === fixture.pluginId);
      expect(isColdPluginRuntimeLoaded(fixture)).toBe(false);
      if (!enabled) {
        expect(plugin).toMatchObject({
          enabled: false,
          status: "disabled",
          toolNames: ["disabled_demo_tool"],
        });
        expect(plugin?.error).toBeUndefined();
        expect(plugin?.dependencyStatus?.missing).toEqual(["missing-required"]);
        expect(report.diagnostics).not.toContainEqual(
          expect.objectContaining({ pluginId: fixture.pluginId, level: "error" }),
        );
        return;
      }
      const message =
        'Plugin "dependency-demo" cannot load because required dependencies are missing: missing-required. Install the plugin dependencies or reinstall/update the plugin, then restart the Gateway.';
      expect(plugin).toEqual(expect.objectContaining({ status: "error", error: message }));
      expect(report.diagnostics).toContainEqual({
        level: "error",
        pluginId: "dependency-demo",
        source: fs.realpathSync(fixture.runtimeSource),
        message,
      });
      expect(plugin?.dependencyStatus).toMatchObject({
        hasDependencies: true,
        installed: false,
        requiredInstalled: false,
        optionalInstalled: false,
        missing: ["missing-required"],
        missingOptional: ["missing-optional"],
        dependencies: [
          { name: "missing-required", spec: "1.0.0", installed: false, optional: false },
          { name: "present-required", spec: "1.0.0", installed: true, optional: false },
        ],
        optionalDependencies: [
          { name: "missing-optional", spec: "1.0.0", installed: false, optional: true },
        ],
      });
    },
  );

  it("preserves the preparation error while explaining missing required dependencies", async () => {
    const rootDir = makeTempDir();
    const bundledRoot = makeTempDir();
    const fixture = createColdPluginFixture({
      rootDir,
      pluginId: "failed-runtime-dependency-demo",
      packageJson: {
        dependencies: { "missing-runtime": "1.0.0", "optional-runtime": "1.0.0" },
        optionalDependencies: { "optional-runtime": "2.0.0" },
      },
    });
    fs.writeFileSync(
      fixture.runtimeSource,
      `require("node:fs").writeFileSync(${JSON.stringify(fixture.runtimeMarker)}, "loaded");\n` +
        'require("missing-runtime");\n',
      "utf8",
    );

    await withPluginDiagnosticsReport(
      {
        config: createColdPluginConfig(rootDir, fixture.pluginId),
        workspaceDir: rootDir,
        env: createColdPluginHermeticEnv(rootDir, { bundledPluginsDir: bundledRoot }),
        logger: { info() {}, warn() {}, error() {}, debug() {} },
      },
      (report) => {
        const plugin = report.plugins.find((entry) => entry.id === fixture.pluginId);
        const diagnostics = report.diagnostics.filter(
          (entry) => entry.pluginId === fixture.pluginId,
        );

        expect(plugin).toMatchObject({
          status: "error",
          dependencyStatus: {
            missing: ["missing-runtime"],
            missingOptional: ["optional-runtime"],
          },
        });
        expect(diagnostics).toHaveLength(1);
        for (const message of [plugin?.error, diagnostics[0]?.message]) {
          expect(message).toContain("Plugin dependency missing-runtime is missing from");
          expect(message).toContain("Install the plugin dependencies");
        }
        expect(isColdPluginRuntimeLoaded(fixture)).toBe(false);
      },
    );
  });
});
