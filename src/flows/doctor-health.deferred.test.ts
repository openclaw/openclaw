// Install fixture mocks before importing the real maintenance owners.
import "./doctor-health.test-support.js";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readWorkspaceStateSnapshot } from "../agents/workspace-state-store.js";
import { hashConfigRaw } from "../config/io.read-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { validateConfigObjectWithPlugins } from "../config/validation.js";
import {
  resolveStateDatabaseCoordinatorPath,
  resolveStateLifecycleRuntimeDirectory,
} from "../infra/state-database-coordinator.js";
import {
  detectLegacyWorkspaceState,
  migrateLegacyWorkspaceState,
} from "../infra/state-migrations.workspace-setup.js";
import { buildUpdateRehearsalPathEnv } from "../infra/update-rehearsal-paths.js";
import { createUpdateRun } from "../infra/update-run-ledger.js";
import { buildUpdateDoctorEnv } from "../infra/update-runner-doctor.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  OPENCLAW_AGENT_SCHEMA_VERSION,
} from "../state/openclaw-agent-db.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import { readStateSchemaContentVersion } from "../state/openclaw-state-db-schema-version.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { removePreparedWorkerOwnershipColumns } from "../state/openclaw-state-schema-v17.test-support.js";
import { withEnvAsync } from "../test-utils/env.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { VERSION } from "../version.js";
import { runDoctorHealthFlow } from "./doctor-health.js";

const { mocks } = await import("./doctor-health.test-support.js");

function downgradeSharedSchema(databasePath: string): void {
  const database = new DatabaseSync(databasePath);
  try {
    removePreparedWorkerOwnershipColumns(database);
    database.exec("PRAGMA user_version = 16; UPDATE schema_meta SET schema_version = 16;");
    database
      .prepare(
        "INSERT INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES (?, ?, ?)",
      )
      .run("repair.fixture", '{"keep":true}', 1);
  } finally {
    database.close();
  }
}

describe("Doctor health during configured-plugin repair deferral", () => {
  afterEach(() => vi.unstubAllEnvs());

  beforeEach(() => {
    vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", undefined);
    vi.stubEnv("OPENCLAW_COMPATIBILITY_HOST_VERSION", undefined);
    vi.stubEnv("OPENCLAW_UPDATE_POST_CORE_CONVERGENCE", undefined);
    vi.stubEnv("OPENCLAW_UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR", undefined);
    vi.stubEnv("OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE", undefined);
    vi.stubEnv("OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH", undefined);
    mocks.config.mockReset().mockReturnValue({});
    mocks.packageRoot.mockReset().mockReturnValue(undefined);
    mocks.service.mockReset();
    mocks.outro.mockClear();
    mocks.runContributions.mockReset().mockResolvedValue(undefined);
    mocks.writeUpdatePostInstallDoctorResult.mockClear();
  });

  it.each(
    ["explicit", "writable-parent"].flatMap((parent) =>
      [false, true].flatMap((resultChannel) =>
        [false, true].map((unreadableState) => ({ parent, resultChannel, unreadableState })),
      ),
    ),
  )(
    "defers before stale plugin hooks or state work ($parent, IPC=$resultChannel, unreadable=$unreadableState)",
    async ({ parent, resultChannel, unreadableState }) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", "1");
        vi.stubEnv(
          parent === "explicit"
            ? "OPENCLAW_UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR"
            : "OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE",
          "1",
        );
        const resultPath = state.path("doctor-result.json");
        if (resultChannel) {
          vi.stubEnv("OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH", resultPath);
        }
        await state.writeConfig({
          agents: { list: [{ id: "main", workspace: state.workspaceDir }] },
          plugins: { entries: { telegram: { enabled: true } } },
        });
        const sourcePath = path.join(state.workspaceDir, "openclaw-workspace-state.json");
        fs.writeFileSync(
          sourcePath,
          JSON.stringify({ version: 1, setupCompletedAt: "2026-07-15T00:00:00.000Z" }),
        );
        const configBefore = fs.readFileSync(state.configPath);
        const sourceBefore = fs.readFileSync(sourcePath);
        const databasePath = resolveOpenClawStateSqlitePath(state.env);
        const coordinatorPath = resolveStateDatabaseCoordinatorPath({
          databasePath,
          runtimeDirectory: resolveStateLifecycleRuntimeDirectory(),
          uid: process.getuid?.(),
        });
        const unreadableBytes = Buffer.from("unreadable state database fixture\n");
        if (unreadableState) {
          fs.mkdirSync(path.dirname(databasePath), { recursive: true });
          fs.writeFileSync(databasePath, unreadableBytes);
        }
        // Retained plugin Doctor hooks can import APIs removed by the new core.
        // The health entrypoint must not reach config discovery before convergence.
        mocks.config.mockImplementation(() => {
          throw new Error("Cannot find module 'openclaw/plugin-sdk/retired-api'");
        });
        const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

        await runDoctorHealthFlow(runtime, { repair: true, nonInteractive: true });

        expect(mocks.config).not.toHaveBeenCalled();
        expect(mocks.runContributions).not.toHaveBeenCalled();
        expect(mocks.service).not.toHaveBeenCalled();
        expect(fs.existsSync(coordinatorPath)).toBe(false);
        expect(fs.readFileSync(state.configPath)).toEqual(configBefore);
        expect(fs.readFileSync(sourcePath)).toEqual(sourceBefore);
        expect(fs.existsSync(`${sourcePath}.doctor-importing`)).toBe(false);
        if (unreadableState) {
          expect(fs.readFileSync(databasePath)).toEqual(unreadableBytes);
        } else {
          // No database means no migration receipts or config observations were written.
          expect(fs.existsSync(databasePath)).toBe(false);
        }
        expect(mocks.outro).not.toHaveBeenCalledWith("Doctor complete.");
        expect(runtime.error).not.toHaveBeenCalled();
        if (resultChannel) {
          expect(mocks.writeUpdatePostInstallDoctorResult).toHaveBeenCalledExactlyOnceWith({
            resultPath,
            result: {
              status: "advisory",
              advisory: {
                kind: "package-post-install-doctor",
                message: expect.any(String),
                reason: "deferred-configured-plugin-repair",
                details: expect.arrayContaining([expect.stringMatching(/defer|post-core/i)]),
              },
              configHash: "unchanged",
            },
          });
          expect(mocks.writeUpdatePostInstallDoctorResult).toHaveBeenCalledBefore(runtime.exit);
          expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(86);
        } else {
          expect(mocks.writeUpdatePostInstallDoctorResult).not.toHaveBeenCalled();
          expect(runtime.exit).not.toHaveBeenCalled();
          expect([...runtime.log.mock.calls, ...mocks.outro.mock.calls].flat().join("\n")).toMatch(
            /deferred.*post-core|post-core.*deferred/is,
          );
        }
      });
    },
  );

  it.each([
    { driverVersion: "2026.9.3", delegated: false },
    { driverVersion: "2026.9.2", delegated: false },
    { driverVersion: "2026.9.3", delegated: true },
  ])(
    "completes only shared schema before the shipped post-install handoff ($driverVersion/$delegated)",
    async ({ driverVersion, delegated }) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        await state.writeConfig({
          agents: {
            ownership: "explicit",
            entries: { main: { workspace: state.workspaceDir }, ops: {} },
          },
          plugins: { enabled: false },
        });
        const sharedPath = openOpenClawStateDatabase({ env: state.env }).path;
        const agentPath = openOpenClawAgentDatabase({ agentId: "ops", env: state.env }).path;
        createUpdateRun({ trigger: "cli", before: { version: driverVersion } }, { env: state.env });
        closeOpenClawAgentDatabasesForTest();
        closeOpenClawStateDatabaseForTest();
        downgradeSharedSchema(sharedPath);
        const agent = new DatabaseSync(agentPath);
        agent.exec(
          `PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION - 1}; UPDATE schema_meta SET schema_version = ${OPENCLAW_AGENT_SCHEMA_VERSION - 1};`,
        );
        agent.close();
        const sourcePath = path.join(state.workspaceDir, "openclaw-workspace-state.json");
        fs.writeFileSync(
          sourcePath,
          JSON.stringify({ version: 1, setupCompletedAt: "2026-07-15T00:00:00.000Z" }),
        );
        const protectedPaths = [state.configPath, agentPath, sourcePath];
        const protectedBytes = protectedPaths.map((file) => fs.readFileSync(file));
        mocks.config.mockImplementation(() => {
          throw new Error("stale plugin contracts must remain deferred");
        });
        const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
        await withEnvAsync(
          {
            ...buildUpdateDoctorEnv({
              allowGatewayServiceRepair: false,
              allowGatewayActivation: false,
              serviceRepairPolicy: "external",
              deferConfiguredPluginInstallRepair: true,
              compatibilityHostVersion: VERSION,
            }),
            OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH: state.path("doctor-result.json"),
          },
          async () => {
            await runDoctorHealthFlow(
              runtime,
              { repair: true, nonInteractive: true },
              delegated
                ? {
                    inputHash: hashConfigRaw(fs.readFileSync(state.configPath, "utf8")),
                    assertCurrent: () => {},
                  }
                : undefined,
            );
          },
        );
        const migrated = new DatabaseSync(sharedPath, { readOnly: true });
        try {
          expect(migrated.prepare("PRAGMA user_version").get()?.user_version).toBe(
            driverVersion === "2026.9.2" ? 16 : OPENCLAW_STATE_SCHEMA_VERSION,
          );
          expect(readStateSchemaContentVersion(migrated)).toBe(OPENCLAW_STATE_SCHEMA_VERSION);
          expect(
            migrated
              .prepare("SELECT value_json FROM config_machine_state WHERE state_key = ?")
              .get("repair.fixture"),
          ).toEqual({ value_json: '{"keep":true}' });
          expect(migrated.prepare("PRAGMA integrity_check").get()).toEqual({
            integrity_check: "ok",
          });
          expect(
            migrated
              .prepare("PRAGMA table_info(worker_environments)")
              .all()
              .map((column) => column.name),
          ).toEqual(
            expect.arrayContaining([
              "last_activated_at_ms",
              "preparation_key",
              "preparation_consumed_at_ms",
            ]),
          );
          expect(migrated.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
        } finally {
          migrated.close();
        }
        expect(protectedPaths.map((file) => fs.readFileSync(file))).toEqual(protectedBytes);
        expect(mocks.config).not.toHaveBeenCalled();
        expect(mocks.runContributions).not.toHaveBeenCalled();
        expect(mocks.service).not.toHaveBeenCalled();
        expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(86);
        expect(mocks.outro).not.toHaveBeenCalledWith("Doctor complete.");
      });
    },
  );

  it.each([
    { owner: "requester", phase: "root" },
    { owner: "executor", phase: "root" },
    { owner: "requester", phase: "maintenance" },
    { owner: "executor", phase: "maintenance" },
  ])(
    "refuses revoked $owner authority after $phase without shared mutation",
    async ({ owner, phase }) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        await state.writeConfig({
          agents: { ownership: "explicit", entries: { main: {} } },
          plugins: { enabled: false },
        });
        const databasePath = openOpenClawStateDatabase({ env: state.env }).path;
        closeOpenClawStateDatabaseForTest();
        downgradeSharedSchema(databasePath);
        const before = fs.readFileSync(databasePath);
        const configBefore = fs.readFileSync(state.configPath);
        let current = true;
        const refusal = new Error(`${owner} authority revoked before schema mutation`);
        const assertCurrent = vi.fn(() => {
          if (!current) {
            throw refusal;
          }
        });
        const maintenanceModule = await import("../commands/doctor-maintenance.js");
        const originalMaintenance = maintenanceModule.beginDoctorMaintenance;
        const maintenance = vi.spyOn(maintenanceModule, "beginDoctorMaintenance");
        if (phase === "root") {
          mocks.packageRoot.mockImplementationOnce(() => {
            current = false;
            return undefined;
          });
        } else {
          maintenance.mockImplementationOnce(async (params) => {
            const acquired = await originalMaintenance(params);
            current = false;
            return acquired;
          });
        }
        const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
        let thrown: unknown;
        assertCurrent(); // Current worker admission precedes asynchronous Doctor preparation.
        try {
          await withEnvAsync(
            {
              ...buildUpdateDoctorEnv({
                allowGatewayServiceRepair: false,
                allowGatewayActivation: false,
                serviceRepairPolicy: "external",
                deferConfiguredPluginInstallRepair: true,
                compatibilityHostVersion: VERSION,
              }),
              OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH: state.path("doctor-result.json"),
            },
            async () => {
              await runDoctorHealthFlow(
                runtime,
                { repair: true, nonInteractive: true },
                {
                  inputHash: hashConfigRaw(configBefore.toString("utf8")),
                  assertCurrent,
                },
              );
            },
          );
        } catch (error) {
          thrown = error;
        } finally {
          maintenance.mockRestore();
        }
        expect(fs.readFileSync(databasePath)).toEqual(before);
        expect(fs.readFileSync(state.configPath)).toEqual(configBefore);
        expect(thrown).toBe(refusal);
        expect(assertCurrent.mock.calls.length).toBeGreaterThan(1);
        expect(mocks.runContributions).not.toHaveBeenCalled();
        expect(mocks.config).not.toHaveBeenCalled();
        expect(mocks.service).not.toHaveBeenCalled();
        expect(runtime.exit).not.toHaveBeenCalledWith(86);
      });
    },
  );

  it.each([
    "no-result",
    "no-compatibility",
    "incomplete-rehearsal",
    "read-only",
    "future",
    "unreadable",
    "foreign-owner",
  ] as const)(
    "preserves shared inputs when post-install schema repair is not admitted (%s)",
    async (mode) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        await state.writeConfig({
          agents: { ownership: "explicit", entries: { main: {} } },
          plugins: { enabled: false },
        });
        const databasePath = openOpenClawStateDatabase({ env: state.env }).path;
        closeOpenClawStateDatabaseForTest();
        downgradeSharedSchema(databasePath);
        if (mode === "future" || mode === "foreign-owner") {
          const database = new DatabaseSync(databasePath);
          if (mode === "future") {
            database.exec(
              `PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION + 1}; UPDATE schema_meta SET schema_version = ${OPENCLAW_STATE_SCHEMA_VERSION + 1};`,
            );
          } else {
            database.exec(
              "UPDATE schema_meta SET role = 'agent', agent_id = 'other' WHERE meta_key = 'primary';",
            );
          }
          database.close();
        }
        if (mode === "unreadable") {
          fs.writeFileSync(databasePath, "unreadable shared database");
        }
        const before = fs.readFileSync(databasePath);
        const configBefore = fs.readFileSync(state.configPath);
        const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
        const refusal = ["read-only", "future", "unreadable", "foreign-owner"].some(
          (value) => value === mode,
        );
        await withEnvAsync(
          {
            ...buildUpdateDoctorEnv({
              allowGatewayServiceRepair: false,
              allowGatewayActivation: false,
              serviceRepairPolicy: "external",
              deferConfiguredPluginInstallRepair: true,
              compatibilityHostVersion: VERSION,
            }),
            ...(mode === "incomplete-rehearsal"
              ? {
                  ...buildUpdateRehearsalPathEnv(state.stateDir),
                  OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR: "1",
                }
              : {}),
            OPENCLAW_COMPATIBILITY_HOST_VERSION:
              mode === "no-compatibility" || mode === "incomplete-rehearsal" ? undefined : VERSION,
            OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH:
              mode === "no-result" ? undefined : state.path("doctor-result.json"),
            OPENCLAW_CONFIG_READONLY: mode === "read-only" ? "1" : undefined,
          },
          async () => {
            const result = runDoctorHealthFlow(runtime, { repair: true, nonInteractive: true });
            if (refusal) {
              await expect(result).rejects.toThrow();
            } else {
              await result;
            }
          },
        );
        expect(fs.readFileSync(databasePath)).toEqual(before);
        expect(fs.readFileSync(state.configPath)).toEqual(configBefore);
        expect(mocks.runContributions).not.toHaveBeenCalled();
        expect(mocks.config).not.toHaveBeenCalled();
        expect(mocks.service).not.toHaveBeenCalled();
      });
    },
  );

  it.each([false, true])(
    "repairs independent config aliases while plugin work is deferred (plugin=%s)",
    async (withPlugin) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", "1");
        vi.stubEnv("OPENCLAW_UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR", "1");
        vi.stubEnv("OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE", "1");
        const pluginRoot = state.statePath("extensions", "fixture");
        const runtimeMarker = state.path("stale-doctor-loaded");
        fs.mkdirSync(pluginRoot, { recursive: true });
        fs.writeFileSync(
          path.join(pluginRoot, "package.json"),
          JSON.stringify({
            name: "@fixture/stale",
            version: "1.0.0",
            openclaw: { extensions: ["./index.js"] },
          }),
        );
        fs.writeFileSync(
          path.join(pluginRoot, "openclaw.plugin.json"),
          JSON.stringify({
            id: "fixture",
            doctorContract: { configRepair: true, stateMigrations: true },
            configSchema: { type: "object" },
          }),
        );
        const pluginSource = `require("node:fs").writeFileSync(${JSON.stringify(runtimeMarker)}, "loaded"); throw new Error("stale plugin API");`;
        fs.writeFileSync(path.join(pluginRoot, "index.js"), pluginSource);
        fs.writeFileSync(path.join(pluginRoot, "doctor-contract-api.js"), pluginSource);
        await state.writeConfig({
          session: { idleMinutes: 45 },
          agents: { entries: {}, defaults: { pdfMaxBytesMb: 5 } },
          tools: { exec: { security: "deny", ask: "off" } },
          plugins: withPlugin
            ? {
                allow: ["fixture"],
                entries: { fixture: { enabled: true } },
                load: { paths: [pluginRoot] },
              }
            : { enabled: false },
        });
        mocks.config.mockImplementation(() => {
          throw new Error("full config flow must wait");
        });
        const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
        await runDoctorHealthFlow(runtime, { repair: true, nonInteractive: true });
        const after = JSON.parse(fs.readFileSync(state.configPath, "utf8"));
        await withEnvAsync({ OPENCLAW_UPDATE_IN_PROGRESS: "0" }, async () => {
          expect(validateConfigObjectWithPlugins(after).ok).toBe(true);
        });
        expect(after.session).toEqual({ reset: { mode: "idle", idleMinutes: 45 } });
        expect(after.agents.defaults).toMatchObject({ pdfMaxMb: 5 });
        expect(after.agents.defaults).not.toHaveProperty("pdfMaxBytesMb");
        expect(after.tools.exec).toEqual({ mode: "deny" });
        expect(fs.existsSync(runtimeMarker)).toBe(false);
        expect(mocks.runContributions).not.toHaveBeenCalled();
        expect(mocks.config).not.toHaveBeenCalled();
        expect(runtime.log).toHaveBeenCalledWith(
          expect.stringContaining("deferred until post-core"),
        );
      });
    },
  );

  it.each([true, false])(
    "migrates copied state only with the complete private rehearsal contract (complete=%s)",
    async (complete) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const workspaceDir = state.statePath("workspace");
        fs.mkdirSync(workspaceDir, { recursive: true });
        const cfg: OpenClawConfig = {
          agents: { ownership: "explicit", entries: { main: { workspace: workspaceDir } } },
          plugins: { enabled: false },
        };
        await state.writeConfig(cfg);
        const sourcePath = path.join(workspaceDir, "openclaw-workspace-state.json");
        const completedAt = "2026-07-15T00:00:00.000Z";
        fs.writeFileSync(sourcePath, JSON.stringify({ version: 1, setupCompletedAt: completedAt }));
        const before = fs.readFileSync(sourcePath);
        const env = {
          ...state.env,
          ...buildUpdateRehearsalPathEnv(state.stateDir),
          OPENCLAW_UPDATE_IN_PROGRESS: "1",
          OPENCLAW_UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR: "1",
          OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "1",
          OPENCLAW_SERVICE_REPAIR_POLICY: "external",
          OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR: complete ? "0" : "1",
          OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION: "0",
          OPENCLAW_COMPATIBILITY_HOST_VERSION: undefined,
        };
        await withEnvAsync(env, async () => {
          mocks.config.mockReturnValue(cfg);
          mocks.runContributions.mockImplementation(async (ctx) => {
            const result = await migrateLegacyWorkspaceState({
              stateDir: state.stateDir,
              env,
              detected: await detectLegacyWorkspaceState({
                cfg: ctx.cfg,
                stateDir: state.stateDir,
                env,
                homedir: () => state.stateDir,
                doctorOnlyStateMigrations: true,
              }),
            });
            expect(result.warnings).toEqual([]);
          });
          const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
          await runDoctorHealthFlow(runtime, { repair: true, nonInteractive: true });
          if (complete) {
            expect(mocks.config).toHaveBeenCalledOnce();
            expect(mocks.runContributions).toHaveBeenCalledOnce();
            expect((await readWorkspaceStateSnapshot(workspaceDir)).setup.setupCompletedAt).toBe(
              completedAt,
            );
            expect(fs.existsSync(sourcePath)).toBe(false);
            expect(
              openOpenClawStateDatabase({ env })
                .db.prepare("SELECT removed_source FROM migration_sources WHERE source_path = ?")
                .get(sourcePath),
            ).toEqual({ removed_source: 1 });
            expect(mocks.outro).toHaveBeenCalledWith("Doctor complete.");
          } else {
            expect(mocks.config).not.toHaveBeenCalled();
            expect(mocks.runContributions).not.toHaveBeenCalled();
            expect(fs.readFileSync(sourcePath)).toEqual(before);
            expect(mocks.outro).not.toHaveBeenCalledWith("Doctor complete.");
          }
          expect(mocks.service).not.toHaveBeenCalled();
          expect(runtime.exit).not.toHaveBeenCalled();
        });
      });
    },
  );

  it.each(["standalone", "post-core"])(
    "still performs real state repair and records its receipt in %s Doctor",
    async (phase) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        if (phase === "post-core") {
          vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", "1");
          vi.stubEnv("OPENCLAW_UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR", "1");
          vi.stubEnv("OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE", "1");
          vi.stubEnv("OPENCLAW_UPDATE_POST_CORE_CONVERGENCE", "1");
        }
        const cfg: OpenClawConfig = {
          agents: { ownership: "explicit", entries: { main: { workspace: state.workspaceDir } } },
        };
        await state.writeConfig(cfg);
        mocks.config.mockReturnValue(cfg);
        const sourcePath = path.join(state.workspaceDir, "openclaw-workspace-state.json");
        const completedAt = "2026-07-15T00:00:00.000Z";
        fs.writeFileSync(sourcePath, JSON.stringify({ version: 1, setupCompletedAt: completedAt }));
        mocks.runContributions.mockImplementation(async (ctx) => {
          const result = await migrateLegacyWorkspaceState({
            stateDir: state.stateDir,
            env: state.env,
            detected: await detectLegacyWorkspaceState({
              cfg: ctx.cfg,
              stateDir: state.stateDir,
              env: state.env,
              homedir: () => state.home,
              doctorOnlyStateMigrations: true,
            }),
          });
          expect(result.warnings).toEqual([]);
        });
        const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

        await runDoctorHealthFlow(runtime, { repair: true, nonInteractive: true });

        expect(mocks.config).toHaveBeenCalledOnce();
        expect(mocks.runContributions).toHaveBeenCalledOnce();
        expect((await readWorkspaceStateSnapshot(state.workspaceDir)).setup.setupCompletedAt).toBe(
          completedAt,
        );
        expect(fs.existsSync(sourcePath)).toBe(false);
        expect(
          openOpenClawStateDatabase({ env: state.env })
            .db.prepare("SELECT removed_source FROM migration_sources WHERE source_path = ?")
            .get(sourcePath),
        ).toEqual({ removed_source: 1 });
        expect(mocks.outro).toHaveBeenCalledWith("Doctor complete.");
        expect(runtime.exit).not.toHaveBeenCalled();
      });
    },
  );
});
