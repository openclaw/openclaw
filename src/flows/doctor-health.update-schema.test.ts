// Install fixture mocks before importing the real maintenance owners.
import "./doctor-health.test-support.js";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as originalCapture from "../commands/doctor-original-capture.js";
import { preflightUpdateDoctorCli } from "../commands/doctor-update-schema-guard.js";
import * as sqliteSnapshot from "../infra/sqlite-snapshot-source.js";
import { buildUpdateRehearsalPathEnv } from "../infra/update-rehearsal-paths.js";
import { createUpdateRun, recordUpdateRunStep } from "../infra/update-run-ledger.js";
import { buildUpdateDoctorEnv } from "../infra/update-runner-doctor.js";
import { finalizeActiveDebugProxyCaptures } from "../proxy-capture/runtime-cleanup.js";
import { initializeDebugProxyCaptureAsync } from "../proxy-capture/runtime.js";
import { withAgentDatabaseMaintenanceLease } from "../state/openclaw-agent-db-maintenance-lease.js";
import { migrateOpenClawAgentDatabaseForMaintenance } from "../state/openclaw-agent-db-maintenance.js";
import { registerOpenClawAgentDatabase } from "../state/openclaw-agent-db-registry.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
  OPENCLAW_AGENT_SCHEMA_VERSION,
} from "../state/openclaw-agent-db.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "../state/openclaw-agent-schema.js";
import { withoutSessionEntrySnapshotsSchema } from "../state/openclaw-agent-session-snapshots-schema.js";
import { getOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
  repairOpenClawStateDatabaseSchema,
} from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { VERSION } from "../version.js";
import { runDoctorHealthFlow } from "./doctor-health.js";

const { mocks } = await import("./doctor-health.test-support.js");

function setSchemaVersion(databasePath: string, version: number): void {
  const db = new DatabaseSync(databasePath);
  try {
    db.exec(`PRAGMA user_version = ${version};`);
    db.prepare("UPDATE schema_meta SET schema_version = ? WHERE meta_key = 'primary'").run(version);
  } finally {
    db.close();
  }
}

function readDatabase(databasePath: string) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return {
      version: db.prepare("PRAGMA user_version").get()?.user_version,
      contentVersion: tableExists(db, "config_machine_state")
        ? db
            .prepare(
              "SELECT value_json FROM config_machine_state WHERE state_key = 'state.schema.contentVersion'",
            )
            .get()?.value_json
        : undefined,
      ledger: tableExists(db, "update_runs")
        ? db.prepare("SELECT * FROM update_runs ORDER BY run_id").all()
        : [],
      captureSessions: tableExists(db, "capture_sessions")
        ? db.prepare("SELECT id, mode FROM capture_sessions ORDER BY id").all()
        : [],
    };
  } finally {
    db.close();
  }
}

describe("Doctor schema bumps under an updating parent", () => {
  afterEach(() => vi.unstubAllEnvs());
  beforeEach(() => {
    mocks.config.mockReturnValue({});
    mocks.packageRoot.mockReturnValue(undefined);
    mocks.runContributions.mockReset();
    mocks.outro.mockClear();
    vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", "1");
  });

  it.each([
    { kind: "state", updaterVersion: "2026.9.2", missingMetadata: true },
    { kind: "agent", updaterVersion: "2026.9.2", missingMetadata: false },
    { kind: "agent", updaterVersion: "2026.9.2-rebuild.1", missingMetadata: false },
  ])(
    "refuses a $kind bump driven by $updaterVersion before changing database bytes, ledger, or config",
    async ({ kind, updaterVersion, missingMetadata }) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const shared = openOpenClawStateDatabase({ env: state.env }).path;
        const agent = openOpenClawAgentDatabase({ agentId: "main", env: state.env }).path;
        createUpdateRun({ trigger: "cli", before: { version: updaterVersion } });
        await closeOpenClawAgentDatabasesAsync();
        await closeOpenClawStateDatabaseAsync();
        const target = kind === "state" ? shared : agent;
        const supported =
          kind === "state" ? OPENCLAW_STATE_SCHEMA_VERSION : OPENCLAW_AGENT_SCHEMA_VERSION;
        setSchemaVersion(target, supported - 1);
        if (missingMetadata) {
          const db = new DatabaseSync(shared);
          db.exec("DROP TABLE config_machine_state");
          db.close();
        }
        const before = readDatabase(shared);
        const quarantine = state.statePath("state", "openclaw-quarantine.sqlite");
        fs.writeFileSync(quarantine, "unreadable quarantine fixture");
        const files = [shared, agent, state.configPath, quarantine];
        const bytes = files.map((file) => fs.readFileSync(file));
        const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

        const failure = await runDoctorHealthFlow(runtime, {
          repair: true,
          nonInteractive: true,
        }).catch((error: unknown) => error);
        expect(failure).toMatchObject({
          code: "update-schema-bump-unfenced",
          updaterVersion,
          databases: [
            { kind, path: target, foundVersion: supported - 1, supportedVersion: supported },
          ],
          commands: [
            "openclaw gateway stop",
            `npm install -g openclaw@${VERSION} --allow-scripts=openclaw`,
            "openclaw doctor --fix",
            "openclaw gateway start",
          ],
        });
        expect(files.map((file) => fs.readFileSync(file))).toEqual(bytes);
        expect(readDatabase(shared)).toEqual(before);
        expect(mocks.runContributions).not.toHaveBeenCalled();
      });
    },
  );

  it.each([
    { driver: "2026.9.2", deferred: true },
    { driver: "2026.9.3-beta.1", deferred: false },
  ])(
    "admits debug capture only after schema publication for $driver",
    async ({ driver, deferred }) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const captureSessionId = `doctor-readiness-${driver}`;
        vi.stubEnv("OPENCLAW_DEBUG_PROXY_ENABLED", "1");
        vi.stubEnv("OPENCLAW_DEBUG_PROXY_SESSION_ID", captureSessionId);
        vi.stubEnv("OPENCLAW_DEBUG_PROXY_URL", undefined);
        vi.stubEnv("OPENCLAW_DEBUG_PROXY_REQUIRE", "1");
        const shared = openOpenClawStateDatabase({ env: state.env }).path;
        const run = createUpdateRun({ trigger: "cli", before: { version: driver } });
        await closeOpenClawStateDatabaseAsync();
        setSchemaVersion(shared, OPENCLAW_STATE_SCHEMA_VERSION - 1);
        mocks.runContributions.mockImplementation(async () => {
          const result = repairOpenClawStateDatabaseSchema({ env: state.env });
          expect(result.warnings).toEqual([]);
          await initializeDebugProxyCaptureAsync("before-readiness");
        });
        const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
        try {
          await runDoctorHealthFlow(runtime, {
            repair: true,
            nonInteractive: true,
          });
        } finally {
          await finalizeActiveDebugProxyCaptures();
          await closeOpenClawStateDatabaseAsync();
        }
        expect(readDatabase(shared).version).toBe(
          OPENCLAW_STATE_SCHEMA_VERSION - (deferred ? 1 : 0),
        );
        if (deferred) {
          expect(readDatabase(shared).contentVersion).toBe(String(OPENCLAW_STATE_SCHEMA_VERSION));
          expect(runtime.log).toHaveBeenCalledWith(
            expect.stringContaining(
              `Schema content applied; version publication deferred until update run ${run.runId} finishes`,
            ),
          );
        }
        expect(readDatabase(shared).captureSessions).toEqual(
          deferred ? [] : [{ id: captureSessionId, mode: "cli" }],
        );
        expect(mocks.outro).toHaveBeenCalledWith("Doctor complete.");
      });
    },
  );

  it("emits a structured refusal with a failure exit for the affected ledger writer", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const shared = openOpenClawStateDatabase({ env: state.env }).path;
      createUpdateRun({ trigger: "cli", before: { version: "2026.9.2" } });
      await closeOpenClawStateDatabaseAsync();
      setSchemaVersion(shared, OPENCLAW_STATE_SCHEMA_VERSION - 1);
      const database = new DatabaseSync(shared);
      database.exec("DROP TABLE config_machine_state");
      database.close();
      const runtime = {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
        writeStdout: vi.fn(),
        writeJson: vi.fn(),
      };
      await expect(
        runDoctorHealthFlow(runtime, { repair: true, nonInteractive: true, json: true }),
      ).rejects.toMatchObject({ code: 1 });
      expect(runtime.exit).toHaveBeenCalledWith(1);
      expect(runtime.writeJson).toHaveBeenCalledWith(
        {
          ok: false,
          error: expect.objectContaining({
            code: "update-schema-bump-unfenced",
            targetVersion: VERSION,
            updaterVersion: "2026.9.2",
            databases: [
              expect.objectContaining({
                kind: "state",
                foundVersion: OPENCLAW_STATE_SCHEMA_VERSION - 1,
              }),
            ],
          }),
        },
        2,
      );
    });
  });

  it.each([
    "owned",
    "flag-only",
    "foreign-agent",
    "early foreign-agent",
    "changed namespace",
  ] as const)(
    "admits the real outer rehearsal only under current maintenance: %s",
    async (mode) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const shared = openOpenClawStateDatabase({ env: state.env }).path;
        let agent = openOpenClawAgentDatabase({ agentId: "main", env: state.env }).path;
        const run = createUpdateRun({ trigger: "cli", before: { version: "2026.9.2" } });
        recordUpdateRunStep(run.runId, {
          step: "openclaw doctor",
          status: mode === "early foreign-agent" ? "in_progress" : "completed",
        });
        if (mode !== "early foreign-agent") {
          recordUpdateRunStep(run.runId, {
            step: "post-update verification",
            status: "in_progress",
          });
        }
        await closeOpenClawAgentDatabasesAsync();
        await closeOpenClawStateDatabaseAsync();
        // Real v23 storage, not a v24 image with only its metadata downgraded.
        fs.unlinkSync(agent);
        const seed = new DatabaseSync(agent);
        try {
          seed.exec(withoutSessionEntrySnapshotsSchema(OPENCLAW_AGENT_SCHEMA_SQL));
          seed.exec(`PRAGMA user_version = 23;
            INSERT INTO schema_meta(meta_key, role, schema_version, agent_id, app_version, created_at, updated_at)
            VALUES ('primary', 'agent', 23, 'main', '2026.9.4', 1, 1)`);
          seed.exec(
            "INSERT INTO cache_entries(scope,key,value_json,expires_at,updated_at) VALUES('test','retained','{\"keep\":true}',NULL,1)",
          );
        } finally {
          seed.close();
        }
        if (mode === "foreign-agent" || mode === "early foreign-agent") {
          const foreign = state.path("foreign-agent");
          fs.mkdirSync(foreign);
          const moved = path.join(foreign, "openclaw-agent.sqlite");
          fs.renameSync(agent, moved);
          agent = moved;
          await state.writeConfig({
            plugins: { enabled: false },
            agents: { ownership: "explicit", entries: { main: { agentDir: foreign } } },
          });
          if (mode === "early foreign-agent") {
            registerOpenClawAgentDatabase({
              agentId: "main",
              path: agent,
              env: state.env,
              schemaVersion: 23,
            });
          }
          await closeOpenClawStateDatabaseAsync();
        }
        const root = fs.realpathSync(state.stateDir);
        for (const [key, value] of Object.entries({
          ...buildUpdateDoctorEnv({
            allowGatewayServiceRepair: false,
            allowGatewayActivation: false,
            serviceRepairPolicy: "external",
          }),
          ...buildUpdateRehearsalPathEnv(root),
        })) {
          vi.stubEnv(key, value);
        }
        vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", "1");
        vi.stubEnv("OPENCLAW_UPDATE_RUN_ID", undefined);
        vi.stubEnv("OPENCLAW_COMPATIBILITY_HOST_VERSION", undefined);
        if (mode === "flag-only") {
          vi.stubEnv("TMPDIR", path.dirname(root));
        }
        const before = [agent, state.configPath].map((filename) => fs.readFileSync(filename));
        const snapshot = sqliteSnapshot.prepareSqliteReadOnlyLocation;
        const observe = vi
          .spyOn(sqliteSnapshot, "prepareSqliteReadOnlyLocation")
          .mockImplementation(async (...args) => {
            const prepared = await snapshot(...args);
            if (mode === "changed namespace" && getOpenClawDatabaseMaintenanceScope()) {
              vi.stubEnv("TMPDIR", path.dirname(root));
            }
            return prepared;
          });
        const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
        // Observe the actual capture owner without replacing its implementation.
        const capture = vi.spyOn(originalCapture, "preserveDoctorOriginalState");
        mocks.runContributions.mockImplementation(async () => {
          const scope = getOpenClawDatabaseMaintenanceScope();
          expect(scope?.ownsSchemaMaintenance).toBe(true);
          if (!scope) {
            throw new Error("Expected real Doctor maintenance");
          }
          scope.assertOwnerCurrent();
          scope.assertDatabaseAccess(shared);
          await withAgentDatabaseMaintenanceLease({ env: process.env }, (lease) =>
            migrateOpenClawAgentDatabaseForMaintenance({ agentId: "main", pathname: agent }, lease),
          );
        });
        try {
          if (mode === "flag-only") {
            await expect(preflightUpdateDoctorCli({})).rejects.toMatchObject({
              code: "update-schema-bump-unfenced",
            });
          } else {
            // The actual CLI preflight must not cache state-only facts as a full fleet.
            const preflight = await preflightUpdateDoctorCli({});
            expect(preflight).toBeUndefined();
            const doctor = runDoctorHealthFlow(
              runtime,
              { repair: true, nonInteractive: true },
              undefined,
              preflight,
            );
            if (mode === "owned") {
              await doctor;
              expect(
                mocks.runContributions,
                runtime.log.mock.calls.flat().join("\n"),
              ).toHaveBeenCalledOnce();
            } else {
              await expect(doctor).rejects.toThrow(
                mode === "changed namespace" ? /namespace changed/ : /schema|coverage|rehearsal/i,
              );
            }
          }
          if (mode !== "owned") {
            expect(capture).not.toHaveBeenCalled();
            expect(mocks.runContributions).not.toHaveBeenCalled();
          }
          expect(fs.readFileSync(state.configPath)).toEqual(before[1]);
          if (mode === "owned") {
            const migrated = new DatabaseSync(agent, { readOnly: true });
            try {
              expect(migrated.prepare("PRAGMA user_version").get()?.user_version).toBe(
                OPENCLAW_AGENT_SCHEMA_VERSION,
              );
              expect(
                migrated.prepare("SELECT value_json FROM cache_entries WHERE key='retained'").get(),
              ).toEqual({ value_json: '{"keep":true}' });
            } finally {
              migrated.close();
            }
          } else {
            expect(fs.readFileSync(agent)).toEqual(before[0]);
          }
        } finally {
          observe.mockRestore();
          capture.mockRestore();
          await closeOpenClawStateDatabaseAsync();
        }
      });
    },
  );
});
