import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";

async function loadFixtureGraph() {
  return {
    registry: await import("../plugins/doctor-contract-registry.test-fixtures.js"),
    installed: await import("../plugins/installed-plugin-index-store-write.js"),
    surfaces: await import("../plugins/legacy-session-surfaces.types.js"),
    agentLifecycle: await import("../state/openclaw-agent-db-lifecycle.js"),
    agent: await import("../state/openclaw-agent-db.js"),
    state: await import("../state/openclaw-state-db.js"),
    paths: await import("../state/openclaw-state-db.paths.js"),
    backup: await import("../state/openclaw-state-schema.test-support.js"),
    deferred: await import("./deferred-plugin-migrations.js"),
    doctor: await import("./state-migrations.doctor.js"),
    messages: await import("./state-migrations.messages.js"),
    plugin: await import("./state-migrations.plugin-doctor.js"),
    fixture: await import("./state-migrations.shard-fixture.test-support.js"),
  };
}
let graph = await loadFixtureGraph();

async function reloadStateDirFixtureGraph() {
  await graph.agentLifecycle.closeOpenClawAgentDatabasesAsync();
  await graph.state.closeOpenClawStateDatabaseAsync();
  vi.resetModules();
  graph = await loadFixtureGraph();
}

function writeJson(file: string, value: unknown) {
  fs.writeFileSync(file, JSON.stringify(value) + "\n");
}

function pluginConfig(
  id: string,
  root?: string,
  entry: { enabled: boolean; config?: Record<string, unknown> } = { enabled: true },
): OpenClawConfig {
  return { plugins: { ...(root ? { load: { paths: [root] } } : {}), entries: { [id]: entry } } };
}

function writePlugin(
  root: string,
  id: string,
  actions: ActionFixture[],
  sessionIds?: string[],
  packageInfo = { name: `@openclaw/${id}`, version: "0.0.0-test" },
) {
  fs.mkdirSync(root, { recursive: true });
  writeJson(path.join(root, "openclaw.plugin.json"), {
    id,
    configSchema: {},
    doctorContract: {
      stateMigrations: true,
      ...(sessionIds ? { resolveSessionStoreAgentIds: true } : {}),
    },
  });
  writeJson(path.join(root, "package.json"), {
    ...packageInfo,
    type: "commonjs",
    openclaw: { extensions: ["./index.cjs"] },
  });
  fs.writeFileSync(path.join(root, "index.cjs"), "module.exports = {};\n");
  fs.writeFileSync(
    path.join(root, "doctor-contract-api.cjs"),
    `const fs = require("node:fs");
module.exports = { stateMigrations: ${JSON.stringify(actions)}.map(([id, marker, change, { content = "migrated", pending, remove, ...action } = {}]) => ({
  ...action, id, label: id,
  detectLegacyState: () => pending === "always" || fs.existsSync(marker) === (pending === "present")
    ? { preview: [id + " pending"] } : null,
  migrateLegacyState: () => {
    if (remove) fs.unlinkSync(marker); else fs.writeFileSync(marker, content);
    return { changes: [change], warnings: [] };
  },
}))${sessionIds ? `, resolveSessionStoreAgentIds: () => ${JSON.stringify(sessionIds)}` : ""} };\n`,
  );
}

type ActionFixture = [
  id: string,
  marker: string,
  change: string,
  options?: {
    content?: string;
    pending?: "always" | "present";
    remove?: boolean;
    doctorOnly?: boolean;
    phase?: "after-session-repair";
  },
];

const tempDirs = createTrackedTempDirs();

async function makeFixture() {
  const root = await tempDirs.make("openclaw-doctor-caller-execution-");
  const fixture = graph.fixture.createMigrationFixture(root, {
    copied: false,
    bundledPluginsDir: path.resolve("extensions"),
  });
  fs.symlinkSync(
    path.resolve("extensions"),
    path.join(root, "extensions"),
    process.platform === "win32" ? "junction" : "dir",
  );
  return fixture;
}

afterEach(async () => {
  await graph.agentLifecycle.closeOpenClawAgentDatabasesAsync();
  graph.agent.closeOpenClawAgentDatabasesForTest();
  await graph.state.closeOpenClawStateDatabaseAsync();
  graph.state.closeOpenClawStateDatabaseForTest();
  await tempDirs.cleanup();
  vi.restoreAllMocks();
});

describe("legacy state migration caller plugin execution", () => {
  it.each([
    // legacy root, install index, phase, direct entry, ordinary-only
    [true, true, undefined, false, false],
    [true, false, "after-session-repair", false, false],
    [false, false, undefined, true, false],
    [false, true, undefined, true, true],
  ] as const)(
    "discovers live actions: legacy=%s indexed=%s phase=%s direct=%s ordinary-only=%s",
    async (legacyRoot, fromInstallIndex, phase, direct, excludeDoctorOnly) => {
      if (legacyRoot) {
        await reloadStateDirFixtureGraph();
      }
      const fixture = await makeFixture();
      // This execution fixture has no candidate package. Its config-root plugin directory
      // must contain only the live owner, not makeFixture's copied-plan bundled tree.
      fs.unlinkSync(path.join(fixture.root, "extensions"));
      const legacyStateDir = legacyRoot
        ? path.join(fixture.homeDir, ".clawdbot")
        : fixture.stateDir;
      const canonicalStateDir = legacyRoot
        ? path.join(fixture.homeDir, ".openclaw")
        : fixture.stateDir;
      const pluginId = "relocated-owner";
      const pluginRoot = fromInstallIndex
        ? path.join(fixture.root, pluginId)
        : path.join(legacyStateDir, "extensions", pluginId);
      const markerPath = path.join(fixture.root, "relocated-action-ran");
      const doctorOnlyMarkerPath = path.join(fixture.root, "doctor-only-action-ran");
      fs.mkdirSync(legacyStateDir, { recursive: true });
      const installRecords = {
        [pluginId]: { source: "path" as const, sourcePath: pluginRoot, installPath: pluginRoot },
      };
      const historicalSchema = legacyRoot && fromInstallIndex;
      if (fromInstallIndex && !historicalSchema) {
        await graph.installed.writePersistedInstalledPluginIndex(
          {
            version: 1,
            hostContractVersion: "2026.7.1",
            compatRegistryVersion: "test",
            migrationVersion: 1,
            policyHash: "test",
            generatedAtMs: 1,
            installRecords,
            plugins: [],
            diagnostics: [],
          },
          { stateDir: legacyStateDir },
        );
        await graph.state.closeOpenClawStateDatabaseAsync();
      }
      const actions: ActionFixture[] = [
        ["relocated-action", markerPath, "migrated relocated action", { phase }],
      ];
      const collision = phase === "after-session-repair";
      if (collision) {
        graph.fixture.writeFixtureFile(path.join(legacyStateDir, "agent/bin/rg"), "legacy binary");
        graph.fixture.writeFixtureFile(
          path.join(legacyStateDir, "agents/main/agent/bin/rg"),
          "current binary",
        );
        actions.push([
          "ordinary-action",
          path.join(fixture.root, "ordinary-action"),
          "ordinary action ran",
          { pending: "always" },
        ]);
      }
      if (excludeDoctorOnly) {
        actions.push([
          "doctor-only-action",
          doctorOnlyMarkerPath,
          "doctor-only action ran",
          {
            content: "must not run",
            doctorOnly: true,
            pending: "always",
          },
        ]);
      }
      writePlugin(pluginRoot, pluginId, actions, collision ? ["voice"] : undefined);
      const cfg = {
        ...pluginConfig(pluginId),
        agents: { entries: { main: {} } },
      };
      writeJson(legacyRoot ? path.join(legacyStateDir, "openclaw.json") : fixture.configPath, cfg);
      const env: NodeJS.ProcessEnv = {
        ...fixture.env,
        OPENCLAW_HOME: fixture.homeDir,
        OPENCLAW_TEST_FAST: "0",
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      };
      if (legacyRoot) {
        delete env.OPENCLAW_STATE_DIR;
        delete env.OPENCLAW_HOME;
        delete env.OPENCLAW_CONFIG_PATH;
      }
      if (historicalSchema) {
        const databasePath = graph.paths.resolveOpenClawStateSqlitePath({
          ...env,
          OPENCLAW_STATE_DIR: legacyStateDir,
        });
        fs.mkdirSync(path.dirname(databasePath), { recursive: true });
        const database = new DatabaseSync(databasePath);
        try {
          database.exec(
            fs.readFileSync(
              new URL("../../test/fixtures/sqlite/openclaw-state-schema-v1.sql", import.meta.url),
              "utf8",
            ),
          );
          database.exec(`
            PRAGMA user_version = 1;
            INSERT INTO schema_meta VALUES ('primary', 'global', 1, NULL, '2026.7.35', 1, 1);
          `);
          database
            .prepare(`
            INSERT INTO installed_plugin_index (
              index_key, version, host_contract_version, compat_registry_version,
              migration_version, policy_hash, generated_at_ms, install_records_json,
              plugins_json, diagnostics_json, updated_at_ms
            ) VALUES ('installed-plugin-index', 1, '2026.7.35', 'test', 1, 'test', 1, ?, '[]', '[]', 1)
          `)
            .run(JSON.stringify(installRecords));
        } finally {
          database.close();
        }
      }
      graph.registry.clearPluginDoctorContractRegistryCache();
      if (legacyRoot && fromInstallIndex) {
        // Default-root relocation precedes the real Doctor's post-rename schema custody.
        const prepare = graph.state.prepareOpenClawStateDatabaseSchema;
        vi.spyOn(graph.state, "prepareOpenClawStateDatabaseSchema").mockImplementation(
          (options, mode) =>
            graph.backup.withStateMigrationBackupForTest(options ?? {}, () =>
              prepare(options, mode),
            ),
        );
      }

      const detected = direct
        ? await graph.doctor.detectLegacyStateMigrations({
            cfg,
            env,
            doctorOnlyStateMigrations: !excludeDoctorOnly,
            legacySessionSurfaces: graph.surfaces.EMPTY_LEGACY_SESSION_SURFACES,
          })
        : undefined;
      const migrate = () =>
        direct
          ? graph.doctor.runLegacyStateMigrations({
              detected: expectDefined(detected, "direct migration detection"),
              config: cfg,
              env,
              legacySessionSurfaces: graph.surfaces.EMPTY_LEGACY_SESSION_SURFACES,
            })
          : fixture.migrate(cfg, { env });
      const result = await migrate();

      const preludeReceipt = graph.fixture.byId(
        result.stepReceipts,
        legacyRoot ? "state-dir" : "retired-core-state",
      );
      expect(preludeReceipt, JSON.stringify(preludeReceipt)).toMatchObject({
        outcome: legacyRoot ? "completed" : "skipped",
      });
      expect(fs.existsSync(legacyStateDir)).toBe(!legacyRoot);
      if (collision) {
        expect(graph.fixture.byId(result.stepReceipts, "agent-dir")).toMatchObject({
          outcome: "warning",
          warnings: [expect.stringContaining(path.join("bin", "rg"))],
        });
        expect(() =>
          graph.messages.throwIfDoctorStateMigrationRefused(result.stepReceipts),
        ).not.toThrow();
        expect(
          graph.fixture.byId(result.stepReceipts, "orphan-session-keys")?.source,
        ).toContainEqual({
          kind: "path",
          path: path.join(canonicalStateDir, "agents", "voice", "sessions", "sessions.json"),
        });
        expect(fs.readFileSync(path.join(fixture.root, "ordinary-action"), "utf8")).toBe(
          "migrated",
        );
        expect(fs.existsSync(path.join(canonicalStateDir, "agent"))).toBe(false);
      } else {
        expect(result.warnings).toEqual([]);
      }
      if (historicalSchema) {
        expect(graph.fixture.byId(result.stepReceipts, "state-schema")).toMatchObject({
          outcome: "completed",
        });
      }
      const source = [{ kind: "owner", id: `plugin:${pluginId}:relocated-action` }];
      const target = [{ kind: "owner", id: `plugin:${pluginId}:doctor-state` }];
      if (phase === "after-session-repair") {
        expect(result.completedPluginIds ?? []).not.toContain(pluginId);
        const prepared = expectDefined(
          "postSessionPluginMigration" in result ? result.postSessionPluginMigration : undefined,
          "relocated post-session action",
        );
        expect(prepared.step).toMatchObject({ source, target, requiredness: "conditional" });
        expect(prepared.plannedActions).toEqual([{ pluginId, id: "relocated-action" }]);
        expect(fs.existsSync(markerPath)).toBe(false);
        const repairs = {
          config: cfg,
          env,
          maintenanceAuthority: { assertCurrent() {} },
          plannedActions: prepared.plannedActions,
        };
        await expect(
          graph.plugin.runPostSessionPluginDoctorStateRepairs(repairs),
        ).resolves.toMatchObject({
          changes: ["migrated relocated action"],
          warnings: [],
          // Nothing is deferred or retained here, so completion is not certified.
          completedPluginIds: undefined,
        });
        await expect(
          graph.plugin.runPostSessionPluginDoctorStateRepairs(repairs),
        ).resolves.toMatchObject({
          changes: [],
          warnings: [],
        });
      } else {
        expect(graph.fixture.byId(result.stepReceipts, "plugin-doctor-state")).toMatchObject({
          source,
          target,
          requiredness: "conditional",
          outcome: "completed",
        });
        expect(result.completedPluginIds?.includes(pluginId) ?? false).toBe(!excludeDoctorOnly);
      }
      expect(fs.readFileSync(markerPath, "utf8")).toBe("migrated");
      expect(fs.existsSync(doctorOnlyMarkerPath)).toBe(false);
    },
  );

  it("retains pending inputs when an installed plugin is disabled after detection", async () => {
    const fixture = await makeFixture();
    fixture.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS = "1";
    const pluginId = "paused-owner";
    const pluginRoot = path.join(fixture.root, pluginId);
    const sourcePath = path.join(fixture.stateDir, "pending-owner-source.json");
    fs.writeFileSync(sourcePath, '{"retained":true}\n');
    writePlugin(
      pluginRoot,
      pluginId,
      [["pending-source", sourcePath, "source migrated", { pending: "present", remove: true }]],
      undefined,
      { name: "@example/paused-owner", version: "1.0.0" },
    );
    const settings = { legacyRoot: sourcePath };
    const cfg = pluginConfig(pluginId, pluginRoot, { enabled: true, config: settings });
    fs.writeFileSync(fixture.configPath, JSON.stringify(cfg));
    const pending = {
      pluginId,
      reason: "Package convergence was deferred.",
      command: "openclaw update repair",
      configPaths: [["plugins", "entries", pluginId, "config"]],
    };
    await graph.deferred.recordDeferredPluginMigrations({ env: fixture.env, pending: [pending] });
    const detected = await graph.doctor.detectLegacyStateMigrations({
      cfg,
      env: fixture.env,
      doctorOnlyStateMigrations: true,
      legacySessionSurfaces: graph.surfaces.EMPTY_LEGACY_SESSION_SURFACES,
    });
    expect(detected.pluginPlans?.hasLegacy).toBe(true);
    const disabledConfig = pluginConfig(pluginId, pluginRoot, { enabled: false, config: settings });
    fs.writeFileSync(fixture.configPath, JSON.stringify(disabledConfig));
    const migrate = (config: OpenClawConfig) =>
      graph.doctor.runLegacyStateMigrations({
        detected,
        config,
        env: fixture.env,
        legacySessionSurfaces: graph.surfaces.EMPTY_LEGACY_SESSION_SURFACES,
      });
    const result = await migrate(disabledConfig);
    expect(result.completedPluginIds ?? []).not.toContain(pluginId);
    expect(fs.readFileSync(sourcePath, "utf8")).toBe('{"retained":true}\n');
    expect(graph.deferred.readDeferredPluginMigrations({ env: fixture.env })).toEqual([pending]);

    fs.writeFileSync(fixture.configPath, JSON.stringify(cfg));
    const resumed = await migrate(cfg);
    expect(resumed.completedPluginIds).toContain(pluginId);
    expect(fs.existsSync(sourcePath)).toBe(false);
    const inspected = await graph.plugin.autoMigrateLegacyPluginDoctorState({
      config: cfg,
      env: fixture.env,
      doctorOnlyStateMigrations: true,
    });
    expect(inspected.completedPluginIds).toContain(pluginId);
    expect(inspected.changes).not.toContain("source migrated");
  });
});
