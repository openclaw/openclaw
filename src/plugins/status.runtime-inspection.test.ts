import fs from "node:fs";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { handlePluginsCommand } from "../auto-reply/reply/commands-plugins.js";
import { buildPluginsCommandParams } from "../auto-reply/reply/commands.test-harness.js";
import { runPluginsDoctorCommand } from "../cli/plugins-cli.runtime.js";
import { runPluginsInspectCommand } from "../cli/plugins-inspect-command.js";
import { readConfigFileSnapshotForWrite, writeConfigFile } from "../config/config.js";
import { defaultRuntime } from "../runtime.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { setGatewayPluginMetadataSnapshot } from "./current-plugin-metadata-snapshot.js";
import { getGatewayPluginMetadataSnapshot } from "./current-plugin-metadata-state.js";
import { selectInstallMutationWriteOptions } from "./install-config-mutation.js";
import { persistPluginInstall } from "./install-persistence.js";
import { readPersistedInstalledPluginIndexInstallRecords } from "./installed-plugin-index-records.js";
import { readPersistedInstalledPluginIndex } from "./installed-plugin-index-store.js";
import { loadAndActivateRootPluginRegistry, loadPluginRegistryHandle } from "./loader.js";
import {
  cleanupPluginLoaderFixturesForTest,
  makePluginLoaderTempDir,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "./loader.test-fixtures.js";
import { mutateManagedPluginEnabled } from "./management-mutations.js";
import { withPluginLifecycleLease } from "./plugin-lifecycle-lease.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import { loadPluginMetadataSnapshot } from "./plugin-metadata-snapshot.js";
import { createInspectionFixture } from "./registry-inspection.test-helpers.js";
import {
  capturePluginRegistryLifecycleEpoch,
  capturePluginRegistryLifecycleSignal,
} from "./registry-lifecycle.js";
import { disposePluginRegistryInstances, getActivePluginRegistry } from "./runtime.js";
import { withPluginRuntimeRegistryScope } from "./runtime/gateway-request-scope.js";
import * as statusSnapshot from "./status-snapshot.js";
import { withPluginDiagnosticsReportForInspection, withPluginDiagnosticsReport } from "./status.js";
import { createDiagnosticsFixture } from "./status.runtime-inspection.test-helpers.js";
import type { OpenClawPluginService } from "./types.js";

function stateEnv(stateDir: string) {
  return {
    OPENCLAW_HOME: stateDir,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
  };
}

function writeJson(dir: string, file: string, value: unknown) {
  fs.writeFileSync(path.join(dir, file), JSON.stringify(value));
}

describe("plugin runtime inspection", () => {
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    clearPluginMetadataLifecycleCaches();
    resetPluginLoaderTestStateForTest();
    closeOpenClawStateDatabaseForTest();
  });

  afterAll(async () => {
    // Retire async admission records before deleted fixture inodes can be reused.
    await closeOpenClawStateDatabaseAsync();
    cleanupPluginLoaderFixturesForTest();
  });

  it("awaits doctor inspection disposal while the active native registration stays usable", async () => {
    const stateDir = makePluginLoaderTempDir();
    const previousExitCode = process.exitCode;
    const output: string[] = [];
    const writeStdout = vi.spyOn(defaultRuntime, "writeStdout").mockImplementation((value) => {
      output.push(value);
    });
    const fixture = createInspectionFixture({ pauseDisposal: true });
    const { connections, disposalStarted: started, finishDisposal: finish } = fixture.state;
    let command: ReturnType<typeof handlePluginsCommand> | undefined;
    try {
      await withEnvAsync(stateEnv(stateDir), async () => {
        useNoBundledPlugins();
        const config = {
          commands: { text: true, plugins: true },
          agents: {
            defaults: { systemAgent: { agentId: "main" } },
            entries: { main: { workspace: stateDir } },
          },
          plugins: fixture.config.plugins,
        };
        // Preserve omitted catalog preferences on this existing config.
        fs.writeFileSync(path.join(stateDir, "openclaw.json"), "{}");
        await writeConfigFile(config);
        const active = await loadAndActivateRootPluginRegistry({
          config,
          workspaceDir: stateDir,
          cache: false,
        });
        const epoch = capturePluginRegistryLifecycleEpoch(active);
        const signal = capturePluginRegistryLifecycleSignal(active, epoch);
        expect(epoch).toBeDefined();
        expect(signal?.aborted).toBe(false);
        const activeConnection = connections[0];
        const readActive = () => activeConnection?.database.prepare("SELECT 42 AS value").get();
        expect(readActive()).toEqual({ value: 42 });
        let replied = false;
        process.exitCode = 7;
        command = withPluginRuntimeRegistryScope(active, () =>
          runPluginsDoctorCommand({ json: true }).then(() => null),
        ).then((result) => {
          replied = true;
          return result;
        });
        await Promise.race([started.promise, command]);
        expect(connections).toHaveLength(2);
        const inspection = connections[1];
        expect(inspection?.disposals).toBe(1);
        expect(inspection?.database.isOpen).toBe(true);
        expect(replied).toBe(false);
        expect(output).toEqual([]);
        expect(process.exitCode).toBe(7);
        expect(readActive()).toEqual({ value: 42 });
        expect(getActivePluginRegistry()).toBe(active);
        expect(capturePluginRegistryLifecycleEpoch(active)).toBe(epoch);
        expect(signal?.aborted).toBe(false);
        finish.resolve();
        await command;
        expect(output).toHaveLength(1);
        expect(process.exitCode, output.join("\n")).toBe(0);
        expect(JSON.parse(output[0] ?? "")).toMatchObject({
          ok: true,
          pluginErrors: [],
          diagnostics: [],
          configurationWarnings: [],
        });
        expect(inspection?.database.isOpen).toBe(false);
        expect(inspection?.disposals).toBe(1);
        expect(activeConnection?.disposals).toBe(0);
        expect(connections.map((connection) => connection.cleanups)).toEqual([0, 0]);
        expect(readActive()).toEqual({ value: 42 });
        expect(getActivePluginRegistry()).toBe(active);
        expect(capturePluginRegistryLifecycleEpoch(active)).toBe(epoch);
        expect(signal?.aborted).toBe(false);
      });
    } finally {
      finish.resolve();
      try {
        await command;
      } finally {
        await fixture.cleanup();
        writeStdout.mockRestore();
        process.exitCode = previousExitCode;
      }
    }
  });

  it.each(["all", "projection-error", "serialization-and-disposal-error"] as const)(
    "keeps native inspection custody through %s",
    async (mode) => {
      const stateDir = makePluginLoaderTempDir();
      const fixture = createInspectionFixture({
        contextEngine: true,
        disposalFailure: mode === "serialization-and-disposal-error",
      });
      const { plugin, config } = fixture;
      const output: string[] = [];
      const writeStdout = vi.spyOn(defaultRuntime, "writeStdout").mockImplementation((value) => {
        expect(fixture.connection().database.isOpen).toBe(false);
        output.push(value);
      });
      const projectionError = new Error("fixture report projection failed");
      const projection = vi.spyOn(statusSnapshot, "projectPluginInstallHealth");
      try {
        await withEnvAsync(stateEnv(stateDir), async () => {
          useNoBundledPlugins();
          await writeConfigFile(config);
          const active = getActivePluginRegistry();
          if (mode.includes("error")) {
            if (mode.startsWith("projection")) {
              projection.mockImplementation(() => {
                throw projectionError;
              });
            }
            const inspection = withPluginDiagnosticsReportForInspection(
              { config, runtimeInspection: true },
              (report) => {
                expect(report.plugins[0]?.id).toBe(plugin.id);
                expect(fixture.connection().database.prepare("SELECT 42 AS value").get()).toEqual({
                  value: 42,
                });
                return JSON.stringify({
                  toJSON() {
                    throw projectionError;
                  },
                });
              },
            );
            if (!mode.includes("and-disposal")) {
              await expect(inspection).rejects.toBe(projectionError);
            } else {
              await expect(inspection).rejects.toMatchObject({
                errors: [projectionError, expect.any(AggregateError)],
              });
            }
          } else {
            await runPluginsInspectCommand(undefined, {
              all: true,
              runtime: true,
              json: true,
            });
            expect(getActivePluginRegistry()).toBe(active);
            expect(output).toHaveLength(1);
            const parsed = JSON.parse(output[0] ?? "");
            expect(parsed[0]).toMatchObject({
              plugin: { id: plugin.id, contextEngineIds: [plugin.id] },
            });
          }
          expect(getActivePluginRegistry()).toBe(active);
          expect(fixture.connection().disposals).toBe(1);
          expect(fixture.connection().database.isOpen).toBe(false);
          expect(fixture.connection().cleanups).toBe(0);
          expect(fixture.state.factoryCalls).toBe(0);
        });
      } finally {
        projection.mockRestore();
        writeStdout.mockRestore();
        await fixture.cleanup();
      }
    },
  );

  it.each([
    { source: "bundled", runtimeKind: undefined },
    { source: "config", runtimeKind: "memory" },
  ] as const)(
    "enables a $source plugin without manifest kind (runtime kind: $runtimeKind)",
    async ({ source, runtimeKind }) => {
      const stateDir = makePluginLoaderTempDir();
      const bundledDir = makePluginLoaderTempDir();
      const pluginId = "policy-candidate";
      const imported = path.join(stateDir, "runtime-imported");
      const plugin = writePlugin({
        id: pluginId,
        dir: path.join(bundledDir, pluginId),
        filename: "index.cjs",
        body: `require("node:fs").writeFileSync(${JSON.stringify(imported)}, "imported"); module.exports = { id: ${JSON.stringify(pluginId)}, kind: ${JSON.stringify(runtimeKind)}, register() {} };`,
      });
      await withEnvAsync(
        {
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
          OPENCLAW_BUNDLED_PLUGINS_DIR: bundledDir,
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: source === "bundled" ? undefined : "1",
        },
        async () => {
          await writeConfigFile({
            plugins: {
              ...(source === "config" ? { load: { paths: [plugin.file] }, allow: [pluginId] } : {}),
              entries: { [pluginId]: { enabled: false } },
            },
          });
          const bootConfig = { plugins: { enabled: false } };
          const boot = loadPluginMetadataSnapshot({ config: bootConfig, env: process.env });
          setGatewayPluginMetadataSnapshot(boot, { config: bootConfig, env: process.env });
          const activeRegistry = getActivePluginRegistry();
          const result = await mutateManagedPluginEnabled({
            pluginId,
            enabled: true,
            caller: "cli",
          });
          expect(result.status).toBe("committed");
          expect(getGatewayPluginMetadataSnapshot()).toBe(boot);
          expect(getActivePluginRegistry()).toBe(activeRegistry);
          const { snapshot } = await readConfigFileSnapshotForWrite();
          expect(snapshot.sourceConfig.plugins?.entries?.[pluginId]?.enabled).toBe(true);
          expect(snapshot.sourceConfig.plugins?.slots?.memory).toBe(
            runtimeKind ? pluginId : undefined,
          );
          expect(fs.existsSync(imported)).toBe(source !== "bundled");
        },
      );
    },
  );

  it.each([
    { source: "marketplace", kind: "memory", mode: "ready", slots: ["memory"] },
    {
      source: "npm",
      kind: ["memory", "context-engine"],
      mode: "ready",
      slots: ["memory", "contextEngine"],
    },
    { source: "npm", kind: undefined, mode: "ready", slots: ["contextEngine"] },
    { source: "npm", kind: "memory", mode: "disabled", slots: [] },
  ] as const)("persists first-install slots for $source ($kind, $mode)", async (testCase) => {
    const stateDir = makePluginLoaderTempDir();
    const configPath = path.join(stateDir, "openclaw.json");
    await withEnvAsync(stateEnv(stateDir), async () => {
      useNoBundledPlugins();
      await writeConfigFile({});
      await withPluginLifecycleLease({}, async () => {
        const { snapshot, writeOptions } = await readConfigFileSnapshotForWrite();
        // Warm the same empty operation inventory that precedes installer publication.
        loadPluginMetadataSnapshot({ allowCurrent: false, config: snapshot.config });
        const pluginId = "first-slot-candidate";
        const pluginDir =
          testCase.source === "npm"
            ? path.join(stateDir, "npm", "projects", pluginId, "node_modules", pluginId)
            : path.join(stateDir, "extensions", pluginId);
        fs.mkdirSync(pluginDir, { recursive: true });
        writeJson(pluginDir, "package.json", {
          name: pluginId,
          version: "1.0.0",
          openclaw: { extensions: ["./index.cjs"] },
        });
        writeJson(pluginDir, "openclaw.plugin.json", {
          id: pluginId,
          kind: testCase.kind,
          configSchema: { type: "object", additionalProperties: false, properties: {} },
        });
        fs.writeFileSync(
          path.join(pluginDir, "index.cjs"),
          `module.exports = { id: ${JSON.stringify(pluginId)}, kind: ${JSON.stringify(testCase.kind ?? "context-engine")}, register() { require("node:fs").writeFileSync(${JSON.stringify(path.join(pluginDir, "registered"))}, "registered"); } };\n`,
        );

        const next = await persistPluginInstall({
          snapshot: {
            config: snapshot.config,
            baseHash: snapshot.hash ?? undefined,
            writeOptions,
          },
          pluginId,
          install: { source: testCase.source, installPath: pluginDir, version: "1.0.0" },
          enable: testCase.mode !== "disabled",
        });
        expect(fs.existsSync(path.join(pluginDir, "registered"))).toBe(false);

        const expectedSlots = testCase.slots.length
          ? Object.fromEntries(testCase.slots.map((slot) => [slot, pluginId]))
          : undefined;
        expect(next.plugins?.slots).toEqual(expectedSlots);
        const persisted = JSON.parse(fs.readFileSync(configPath, "utf8"));
        expect(persisted.plugins?.slots).toEqual(expectedSlots);
        expect(persisted.plugins?.load?.paths).toBeUndefined();
        expect(readPersistedInstalledPluginIndexInstallRecords()?.[pluginId]).toMatchObject({
          source: testCase.source,
          installPath: pluginDir,
        });
      });
    });
  });

  it.each([false, true])(
    "uses replaced package metadata while preserving its old snapshot (requires config: %s)",
    async (requiresConfig) => {
      const stateDir = makePluginLoaderTempDir();
      const configPath = path.join(stateDir, "openclaw.json");
      const pluginId = "same-path-candidate";
      const pluginDir = path.join(stateDir, "extensions", pluginId);
      const writeVersion = (version: "1.0.0" | "2.0.0") => {
        fs.mkdirSync(pluginDir, { recursive: true });
        writeJson(pluginDir, "package.json", {
          name: pluginId,
          version,
          openclaw: { extensions: ["./index.cjs"] },
        });
        writeJson(pluginDir, "openclaw.plugin.json", {
          id: pluginId,
          version,
          kind: version === "1.0.0" ? "context-engine" : ["context-engine", "memory"],
          configSchema:
            version === "2.0.0" && requiresConfig
              ? { type: "object", properties: { token: { type: "string" } }, required: ["token"] }
              : { type: "object" },
        });
        fs.writeFileSync(
          path.join(pluginDir, "index.cjs"),
          "module.exports = { register() {} };\n",
        );
      };
      const persistVersion = (
        version: string,
        { snapshot, writeOptions }: Awaited<ReturnType<typeof readConfigFileSnapshotForWrite>>,
      ) =>
        persistPluginInstall({
          snapshot: {
            config: snapshot.sourceConfig,
            baseHash: snapshot.hash ?? undefined,
            writeOptions: selectInstallMutationWriteOptions(writeOptions),
          },
          pluginId,
          install: { source: "path", installPath: pluginDir, version },
        });

      await withEnvAsync(stateEnv(stateDir), async () => {
        useNoBundledPlugins();
        await writeConfigFile({});
        writeVersion("1.0.0");
        await withPluginLifecycleLease({}, async () => {
          await persistVersion("1.0.0", await readConfigFileSnapshotForWrite());
        });
        const before = await withPluginLifecycleLease({}, async () => {
          const prepared = await readConfigFileSnapshotForWrite();
          const retainedSnapshot = loadPluginMetadataSnapshot({
            allowCurrent: false,
            config: prepared.snapshot.sourceConfig,
          });
          expect(prepared.snapshot.sourceConfig.plugins?.slots?.contextEngine).toBe(pluginId);

          // The installer replaces this path after the operation has inspected v1.
          writeVersion("2.0.0");
          await persistVersion("2.0.0", prepared);
          return retainedSnapshot;
        });
        const persisted = JSON.parse(fs.readFileSync(configPath, "utf8"));
        expect(persisted.plugins.entries[pluginId].enabled).toBe(!requiresConfig);
        if (requiresConfig) {
          expect(persisted.plugins.slots?.memory).toBeUndefined();
        } else {
          expect(persisted.plugins.slots).toEqual({ contextEngine: pluginId, memory: pluginId });
        }
        const index = await readPersistedInstalledPluginIndex();
        expect(index?.installRecords[pluginId]).toMatchObject({
          installPath: pluginDir,
          version: "2.0.0",
        });
        expect(index?.plugins.find((plugin) => plugin.pluginId === pluginId)).toMatchObject({
          packageVersion: "2.0.0",
          enabled: !requiresConfig,
          startup: { memory: true },
        });
        expect(before.byPluginId.get(pluginId)).toMatchObject({
          version: "1.0.0",
          kind: "context-engine",
        });
        expect(before.byPluginId.get(pluginId)?.configSchema).toEqual({ type: "object" });
      });
    },
  );

  it.each(["during-import", "between-entries"] as const)(
    "rechecks install authority when it closes %s",
    async (closedAt) => {
      const stateDir = makePluginLoaderTempDir();
      const configPath = path.join(stateDir, "openclaw.json");
      await withEnvAsync(stateEnv(stateDir), async () => {
        useNoBundledPlugins();
        await writeConfigFile({});
        await withPluginLifecycleLease({}, async () => {
          const { snapshot, writeOptions } = await readConfigFileSnapshotForWrite();
          const previousConfig = fs.readFileSync(configPath, "utf8");
          loadPluginMetadataSnapshot({ allowCurrent: false, config: snapshot.config });
          const pluginId = "slot-authority-candidate";
          const pluginDir = path.join(
            stateDir,
            "npm",
            "projects",
            pluginId,
            "node_modules",
            pluginId,
          );
          fs.mkdirSync(pluginDir, { recursive: true });
          writeJson(pluginDir, "package.json", {
            name: pluginId,
            version: "1.0.0",
            openclaw: { extensions: ["./first.cjs", "./second.cjs"] },
          });
          writeJson(pluginDir, "openclaw.plugin.json", {
            id: pluginId,
            configSchema: { type: "object" },
          });
          for (const [entry, kind] of [
            ["first", "memory"],
            ["second", "context-engine"],
          ]) {
            fs.writeFileSync(
              path.join(pluginDir, `${entry}.cjs`),
              `require("node:fs").writeFileSync(${JSON.stringify(path.join(stateDir, `${entry}.txt`))}, "imported");
module.exports = { id: ${JSON.stringify(`${pluginId}/${entry}`)}, kind: ${JSON.stringify(kind)}, register() {} };
`,
            );
          }
          let authorityActive = true;

          await expect(
            persistPluginInstall({
              snapshot: {
                config: snapshot.config,
                baseHash: snapshot.hash ?? undefined,
                writeOptions,
              },
              pluginId,
              install: { source: "npm", installPath: pluginDir, version: "1.0.0" },
              beforePersistentApply() {
                if (
                  !authorityActive ||
                  (closedAt === "between-entries" &&
                    fs.existsSync(path.join(stateDir, "first.txt")))
                ) {
                  throw new Error("install authority closed");
                }
                if (closedAt === "during-import") {
                  queueMicrotask(() => {
                    authorityActive = false;
                  });
                }
              },
            }),
          ).rejects.toThrow("install authority closed");

          expect(fs.existsSync(path.join(stateDir, "first.txt"))).toBe(
            closedAt === "between-entries",
          );
          expect(fs.existsSync(path.join(stateDir, "second.txt"))).toBe(false);
          expect(fs.readFileSync(configPath, "utf8")).toBe(previousConfig);
          expect(readPersistedInstalledPluginIndexInstallRecords()?.[pluginId]).toBeUndefined();
        });
      });
    },
  );

  it("captures full registrations through the non-activating inspection mode", async () => {
    const plugin = writePlugin({
      id: "runtime-inspection-route",
      registration: `
if (api.registrationMode === "tool-discovery") {
  api.registerHttpRoute({
    path: "/runtime-inspection", auth: "plugin", handler() { return true; },
  });
}`,
    });
    const stateDir = makePluginLoaderTempDir();
    const config = {
      plugins: {
        load: { paths: [plugin.file] },
        allow: [plugin.id],
      },
    };

    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      useNoBundledPlugins();
      const params = { config, workspaceDir: plugin.dir, env: process.env };

      await withPluginDiagnosticsReport(params, (diagnostics) => {
        expect(diagnostics.plugins.find((entry) => entry.id === plugin.id)?.httpRoutes).toBe(0);
      });

      await withPluginDiagnosticsReport({ ...params, runtimeInspection: true }, (report) => {
        expect(report.plugins.find((entry) => entry.id === plugin.id)?.httpRoutes).toBe(1);
      });
    });
  });
});

it("retires runtime diagnostics after each actual chat inspect reply", async () => {
  await withOpenClawTestState({ label: "diagnostics-chat" }, async (state) => {
    const { id, event, config, disposed } = createDiagnosticsFixture(state);
    await state.writeConfig(config);
    const before = process.listenerCount(event);
    for (const name of [id, "all"]) {
      const result = await handlePluginsCommand(
        buildPluginsCommandParams({
          cfg: config,
          workspaceDir: state.workspaceDir,
          commandBodyNormalized: `/plugins inspect ${name}`,
        }),
        true,
      );
      expect(result?.reply?.text).toContain("diagnostics-resource-service");
      expect(result?.reply?.text).toContain('"status": "loaded"');
      expect(process.listenerCount(event)).toBe(before);
    }
    expect(fs.readFileSync(disposed, "utf8")).toBe("disposed\ndisposed\n");
  });
});

it("keeps metadata getters live through awaited projection without retiring an independent handle", async () => {
  await withOpenClawTestState({ label: "diagnostics-projection" }, async (state) => {
    const { id, event, config, disposed } = createDiagnosticsFixture(state);
    const params = {
      config,
      env: state.env,
      workspaceDir: state.workspaceDir,
      onlyPluginIds: [id],
    };
    const before = process.listenerCount(event);
    const independent = loadPluginRegistryHandle({ ...params, cache: false });
    const entered = createDeferredCore();
    const release = createDeferredCore();
    let retained: OpenClawPluginService | undefined;
    const projection = withPluginDiagnosticsReport(params, async (report) => {
      retained = report.services[0]?.service;
      entered.resolve();
      await release.promise;
      return retained?.id;
    });
    try {
      await entered.promise;
      await nextTurn();
      expect(process.listenerCount(event)).toBe(before + 2);
      expect(fs.existsSync(disposed)).toBe(false);
      release.resolve();
      expect(await projection).toBe("diagnostics-resource-service");
      expect(process.listenerCount(event)).toBe(before + 1);
      expect(() => retained?.id).toThrow(/reloaded|disabled|retir/);
      expect(independent.services[0]?.service.id).toBe("diagnostics-resource-service");
    } finally {
      release.resolve();
      await projection;
      await disposePluginRegistryInstances(independent);
    }
    expect(process.listenerCount(event)).toBe(before);
    expect(fs.readFileSync(disposed, "utf8")).toBe("disposed\ndisposed\n");
  });
});

it("preserves the diagnostics projection failure after best-effort instance cleanup", async () => {
  await withOpenClawTestState({ label: "diagnostics-failure" }, async (state) => {
    const { id, event, config, disposed } = createDiagnosticsFixture(state, true);
    const before = process.listenerCount(event);
    const projectionError = new Error("fixture projection rejected");
    const failure = await withPluginDiagnosticsReport(
      { config, env: state.env, onlyPluginIds: [id] },
      () => {
        throw projectionError;
      },
    ).catch((error: unknown) => error);
    expect(failure).toBe(projectionError);
    expect(process.listenerCount(event)).toBe(before);
    expect(fs.readFileSync(disposed, "utf8")).toBe("disposed\n");
  });
});
