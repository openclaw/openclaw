import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { clearPluginDoctorContractRegistryCache } from "../plugins/doctor-contract-registry.test-fixtures.js";
import { writePersistedInstalledPluginIndex } from "../plugins/installed-plugin-index-store-write.js";
import { EMPTY_LEGACY_SESSION_SURFACES } from "../plugins/legacy-session-surfaces.types.js";
import * as pluginSetupModule from "../plugins/plugin-setup-module.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db-lifecycle.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import {
  readDeferredPluginMigrations,
  recordDeferredPluginMigrations,
} from "./deferred-plugin-migrations.js";
import {
  expectBlockedTailInPlanOrder,
  expectPlanReceiptDescriptorsToMatch,
} from "./state-migrations.caller-mode.test-helpers.js";
import {
  detectLegacyStateMigrations,
  runLegacyStateMigrations,
} from "./state-migrations.doctor.js";
import { throwIfDoctorStateMigrationRefused } from "./state-migrations.messages.js";
import {
  autoMigrateLegacyPluginDoctorState,
  runPostSessionPluginDoctorStateRepairs,
} from "./state-migrations.plugin-doctor.js";
import {
  byId,
  createMigrationFixture,
  writeFixtureFile,
} from "./state-migrations.shard-fixture.test-support.js";
import { resetAutoMigrateLegacyStateDirForTest } from "./state-migrations.state-dir.js";

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
  const fixture = createMigrationFixture(root, {
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
  resetAutoMigrateLegacyStateDirForTest();
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  await tempDirs.cleanup();
  vi.restoreAllMocks();
});

describe("legacy state migration caller plugin execution", () => {
  const orderedIds = ["first-action", "second-action"];
  it.each([
    ["reordered", orderedIds, orderedIds.toReversed(), ["second-action"], true],
    ["missing", ["first-action"], [], [], true],
    ["matching", orderedIds, orderedIds, ["second-action"], false],
  ] as const)(
    "validates %s runtime exports against the immutable manifest order",
    async (_name, manifestIds, runtimeIds, pendingIds, refused) => {
      const fixture = await makeFixture();
      const candidateRoot = path.join(fixture.root, "surprise-candidate");
      const bundledRoot = path.join(candidateRoot, "extensions");
      const pluginRoot = path.join(bundledRoot, "surprise-owner");
      const mutationPath = path.join(fixture.root, "unplanned-migration-ran");
      fs.mkdirSync(pluginRoot, { recursive: true });
      writeJson(path.join(pluginRoot, "openclaw.plugin.json"), {
        id: "surprise-owner",
        configSchema: { type: "object", additionalProperties: false, properties: {} },
        doctorContract: {
          stateMigrations: manifestIds.map((id) => ({ id })),
        },
      });
      fs.writeFileSync(
        path.join(pluginRoot, "index.ts"),
        'export default { id: "surprise-owner", name: "Surprise owner", register() {} };\n',
      );
      fs.writeFileSync(
        path.join(pluginRoot, "doctor-contract-api.ts"),
        `import fs from "node:fs";
export const stateMigrations = ${JSON.stringify(runtimeIds)}.map((id) => ({
  id,
  label: id,
  detectLegacyState: () => ${JSON.stringify(pendingIds)}.includes(id) ? { preview: [id + " pending"] } : null,
  migrateLegacyState: () => {
    fs.appendFileSync(${JSON.stringify(mutationPath)}, id + "\\n");
    return { changes: [id + " migrated"], warnings: [] };
  },
}));
`,
      );
      fixture.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledRoot;

      const plan = await fixture.plan({ candidate: { root: candidateRoot, version: "test" } });
      const plannedSources = manifestIds.map((id) => ({
        kind: "owner",
        id: `plugin:surprise-owner:${id}`,
      }));
      expect(plan.steps.find((step) => step.refusal !== undefined)).toMatchObject({
        id: "skill-workshop",
        outcome: "deferred",
        refusal: { code: "skill-workshop-planning-deferred" },
      });
      expect(byId(plan.steps, "plugin-doctor-state")).toMatchObject({
        source: plannedSources,
        outcome: "deferred",
        refusal: { code: "blocked-by-prior-refusal" },
      });

      const result = await fixture.migrate({});

      if (!refused) {
        expect(byId(result.stepReceipts, "plugin-doctor-state")).toMatchObject({
          source: plannedSources,
          outcome: "completed",
          changes: ["second-action migrated"],
          warnings: [],
        });
        expect(fs.readFileSync(mutationPath, "utf8")).toBe("second-action\n");
        return;
      }
      expect(byId(result.stepReceipts, "plugin-doctor-state")).toMatchObject({
        source: plannedSources,
        outcome: "refused",
        refusal: { code: "step-refused" },
        warnings: [expect.stringContaining("immutable action order")],
      });
      expectBlockedTailInPlanOrder({
        plan,
        receipts: result.stepReceipts,
        blockerId: "plugin-doctor-state",
      });
      expectPlanReceiptDescriptorsToMatch({ plan, receipts: result.stepReceipts });
      expect(fs.existsSync(mutationPath)).toBe(false);
    },
  );

  it("continues to post-session repairs after quarantining a legacy agent collision in live Doctor", async () => {
    const fixture = await makeFixture();
    const pluginId = "external-doctor-owner";
    const pluginRoot = path.join(fixture.root, pluginId);
    const mutationPath = path.join(fixture.stateDir, "external-plugin-migrated");
    const postSessionPath = path.join(fixture.stateDir, "external-plugin-session-migrated");
    const legacyAgentDir = path.join(fixture.stateDir, "agent");
    fixture.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS = "1";
    writeFixtureFile(path.join(legacyAgentDir, "settings.json"), "{}\n");
    writeFixtureFile(path.join(legacyAgentDir, "bin", "rg"), "legacy binary");
    const targetBin = path.join(fixture.stateDir, "agents", "main", "agent", "bin");
    writeFixtureFile(path.join(targetBin, "rg"), "current binary");
    writePlugin(
      pluginRoot,
      pluginId,
      [
        [
          "external-state",
          mutationPath,
          "migrated external state",
          { content: "migrated\n", pending: "always" },
        ],
        [
          "external-session-state",
          postSessionPath,
          "migrated external session state",
          { content: "migrated\n", doctorOnly: true, phase: "after-session-repair" },
        ],
      ],
      ["voice"],
    );
    const cfg = {
      ...pluginConfig(pluginId, pluginRoot),
      agents: { entries: { main: {} } },
    };
    writeJson(fixture.configPath, cfg);
    clearPluginDoctorContractRegistryCache();

    const copiedStatePlan = await fixture.plan();
    expect(byId(copiedStatePlan.steps, "plugin-migration-preparation")).toMatchObject({
      outcome: "deferred",
      refusal: { code: "plugin-planning-deferred" },
    });
    expect(fs.existsSync(mutationPath)).toBe(false);
    clearPluginDoctorContractRegistryCache();

    const result = await fixture.migrate(cfg);

    expect(byId(result.stepReceipts, "plugin-doctor-state")).toMatchObject({
      source: [{ kind: "owner", id: `plugin:${pluginId}:external-state` }],
      target: [{ kind: "owner", id: `plugin:${pluginId}:doctor-state` }],
      outcome: "completed",
    });
    expect(byId(result.stepReceipts, "agent-dir")).toMatchObject({
      outcome: "warning",
      warnings: [expect.stringContaining(path.join("bin", "rg"))],
    });
    expect(() => throwIfDoctorStateMigrationRefused(result.stepReceipts)).not.toThrow();
    expect(byId(result.stepReceipts, "orphan-session-keys")?.source).toContainEqual({
      kind: "path",
      path: path.join(fixture.stateDir, "agents", "voice", "sessions", "sessions.json"),
    });
    expect(fs.readFileSync(mutationPath, "utf8")).toBe("migrated\n");
    expect(fs.existsSync(legacyAgentDir)).toBe(false);
    const postSession = expectDefined(
      result.postSessionPluginMigration,
      "prepared external plugin session migration",
    );
    expect(postSession.step).toMatchObject({
      source: [{ kind: "owner", id: `plugin:${pluginId}:external-session-state` }],
      target: [{ kind: "owner", id: `plugin:${pluginId}:doctor-state` }],
      requiredness: "conditional",
    });
    expect(fs.existsSync(postSessionPath)).toBe(false);
    const repairParams = {
      config: cfg,
      env: fixture.env,
      maintenanceAuthority: { assertCurrent() {} },
      plannedActions: postSession.plannedActions,
    };
    await expect(runPostSessionPluginDoctorStateRepairs(repairParams)).resolves.toMatchObject({
      changes: ["migrated external session state"],
      warnings: [],
    });
    expect(fs.readFileSync(postSessionPath, "utf8")).toBe("migrated\n");
    await expect(runPostSessionPluginDoctorStateRepairs(repairParams)).resolves.toMatchObject({
      changes: [],
      warnings: [],
    });
  });

  it.each([
    // legacy root, install index, phase, direct entry, old schema, ordinary-only
    [true, true, undefined, false, false, false],
    [true, false, "after-session-repair", false, false, false],
    [false, false, undefined, true, false, false],
    [false, true, undefined, true, true, false],
    [false, true, undefined, true, false, true],
  ] as const)(
    "discovers live actions: legacy=%s indexed=%s phase=%s direct=%s old-schema=%s ordinary-only=%s",
    async (legacyRoot, fromInstallIndex, phase, direct, legacySchema, excludeDoctorOnly) => {
      const fixture = await makeFixture();
      // This execution fixture has no candidate package. Its config-root plugin directory
      // must contain only the live owner, not makeFixture's copied-plan bundled tree.
      fs.unlinkSync(path.join(fixture.root, "extensions"));
      const legacyStateDir = legacyRoot
        ? path.join(fixture.homeDir, ".clawdbot")
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
      if (fromInstallIndex && !legacySchema) {
        await writePersistedInstalledPluginIndex(
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
        await closeOpenClawStateDatabaseAsync();
      }
      const actions: ActionFixture[] = [
        ["relocated-action", markerPath, "migrated relocated action", { phase }],
      ];
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
      writePlugin(pluginRoot, pluginId, actions);
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
      if (legacySchema) {
        const databasePath = resolveOpenClawStateSqlitePath(env);
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
      clearPluginDoctorContractRegistryCache();

      const detected = direct
        ? await detectLegacyStateMigrations({
            cfg,
            env,
            doctorOnlyStateMigrations: !excludeDoctorOnly,
            legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
          })
        : undefined;
      if (legacySchema) {
        expect(detected?.stateSchema.hasLegacy).toBe(true);
      }
      const result = direct
        ? await runLegacyStateMigrations({
            detected: expectDefined(detected, "direct migration detection"),
            config: cfg,
            env,
            legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
          })
        : await fixture.migrate(cfg, { env });

      const preludeReceipt = byId(
        result.stepReceipts,
        legacyRoot ? "state-dir" : "retired-core-state",
      );
      expect(preludeReceipt, JSON.stringify(preludeReceipt)).toMatchObject({
        outcome: legacyRoot ? "completed" : "skipped",
      });
      expect(fs.existsSync(legacyStateDir)).toBe(!legacyRoot);
      expect(result.warnings).toEqual([]);
      if (legacySchema) {
        expect(byId(result.stepReceipts, "state-schema")).toMatchObject({
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
        await expect(
          runPostSessionPluginDoctorStateRepairs({
            config: cfg,
            env,
            maintenanceAuthority: { assertCurrent() {} },
            plannedActions: prepared.plannedActions,
          }),
        ).resolves.toMatchObject({
          changes: ["migrated relocated action"],
          warnings: [],
          // Nothing is deferred or retained here, so completion is not certified.
          completedPluginIds: undefined,
        });
      } else {
        expect(byId(result.stepReceipts, "plugin-doctor-state")).toMatchObject({
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
    await recordDeferredPluginMigrations({ env: fixture.env, pending: [pending] });
    const detected = await detectLegacyStateMigrations({
      cfg,
      env: fixture.env,
      doctorOnlyStateMigrations: true,
      legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
    });
    expect(detected.pluginPlans?.hasLegacy).toBe(true);
    const disabledConfig = pluginConfig(pluginId, pluginRoot, { enabled: false, config: settings });
    fs.writeFileSync(fixture.configPath, JSON.stringify(disabledConfig));
    const migrate = (config: OpenClawConfig) =>
      runLegacyStateMigrations({
        detected,
        config,
        env: fixture.env,
        legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
      });
    const result = await migrate(disabledConfig);
    expect(result.completedPluginIds ?? []).not.toContain(pluginId);
    expect(fs.readFileSync(sourcePath, "utf8")).toBe('{"retained":true}\n');
    expect(readDeferredPluginMigrations({ env: fixture.env })).toEqual([pending]);

    fs.writeFileSync(fixture.configPath, JSON.stringify(cfg));
    const resumed = await migrate(cfg);
    expect(resumed.completedPluginIds).toContain(pluginId);
    expect(fs.existsSync(sourcePath)).toBe(false);
    const inspected = await autoMigrateLegacyPluginDoctorState({
      config: cfg,
      env: fixture.env,
      doctorOnlyStateMigrations: true,
    });
    expect(inspected.completedPluginIds).toContain(pluginId);
    expect(inspected.changes).not.toContain("source migrated");
  });

  it("defers a dynamic bundled session-store owner without loading its contract in copied planning", async () => {
    const fixture = await makeFixture();
    const cfg = pluginConfig("voice-call", undefined, {
      enabled: true,
      config: { agentId: "voice" },
    });
    writeJson(fixture.configPath, cfg);
    const pluginLoader = vi
      .spyOn(pluginSetupModule, "getPluginSetupModuleLoader")
      .mockImplementation(() => {
        throw new Error("copied planning must not load a Doctor contract");
      });
    const plan = await fixture.plan();
    expect(byId(plan.steps, "plugin-migration-preparation")).toMatchObject({
      source: expect.arrayContaining([{ kind: "owner", id: "plugin:voice-call" }]),
      outcome: "deferred",
      refusal: { code: "plugin-planning-deferred" },
    });
    expect(pluginLoader).not.toHaveBeenCalled();
  });
});
