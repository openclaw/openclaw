// Prepare declared workers during collection, outside the scenario deadline.
import "../server-start.js";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { prepareDoctorContext } from "../../commands/doctor-config-flow.test-support.js";
import { runDoctorConfigPreflight } from "../../commands/doctor-config-preflight.js";
import { prepareDoctorDatabasePreflight } from "../../commands/doctor-database-preflight.js";
import { beginDoctorMaintenance } from "../../commands/doctor-maintenance.js";
import { backupDoctorMigrationDatabases } from "../../commands/doctor-migration-backup.js";
import { createConfigIO, getRuntimeConfig, resetConfigRuntimeState } from "../../config/config.js";
import { captureRuntimeConfigAsyncReader } from "../../config/io.runtime.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { loadSessionEntryReadOnly } from "../../config/sessions/session-accessor.sqlite-entry.js";
import { readRecentUserAssistantTextForSession } from "../../config/sessions/transcript.js";
import { runInitialConfigWriteHealth } from "../../flows/doctor-health-contribution-runners.config.js";
import { createSqliteReadOnlyWorkerScope } from "../../infra/sqlite-readonly-worker.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../../state/openclaw-agent-db.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../../state/openclaw-state-db-contract.js";
import { getUserPreferences } from "../../state/user-preferences.test-support.js";
import { readAgentDeletionJournal } from "../../test-utils/agent-deletion-journal.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { resumeAgentDeletions } from "../server-agent-deletion-recovery.js";
import { loadGatewayStartupConfigSnapshot } from "../server-startup-config-helpers.js";
import { runStartupSessionMaintenanceForTest } from "../server-startup-session-migration.test-support.js";
import { createDeletionCron, deletionGatewayEnv } from "./agents-delete.fixture.test-support.js";
import { seedLegacyAgentDeletionFixture } from "./legacy-agent-deletion-fixture.test-support.js";

let scenarioWork: Promise<void> | undefined;
afterEach(async () => {
  // Join a timed-out body before another fixture changes process.env.
  await scenarioWork;
  scenarioWork = undefined;
});

function rows(file: string, sql: string) {
  using database = new DatabaseSync(file, { readOnly: true });
  return database.prepare(sql).all();
}

function expectHealthySchema(file: string, version?: number) {
  expect(rows(file, "PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
  if (version !== undefined) {
    expect(rows(file, "PRAGMA user_version")).toEqual([{ user_version: version }]);
  }
}

function readKeeperStorage(file: string) {
  return {
    entries: rows(
      file,
      "SELECT session_key, current_session_id, entry_json FROM session_nodes ORDER BY session_key",
    ),
    transcripts: rows(
      file,
      "SELECT session_id, seq, event_json, hex(event_zstd) AS compressed, event_utf8_bytes FROM transcript_events ORDER BY session_id, seq",
    ),
  };
}

it.for([true, false])(
  "upgrades v2026.9.9 with a pending phase-less deletion (deleteFiles=%s) and preserves the keeper",
  { timeout: 90_000 },
  async (deleteFiles, { signal }) => {
    await (scenarioWork = withOpenClawTestState(
      {
        label: "agent-delete-stable-upgrade",
        layout: "split",
        env: {
          ...deletionGatewayEnv,
          OPENCLAW_DISABLE_BONJOUR: "1",
        },
      },
      async (state) => {
        const fixture = seedLegacyAgentDeletionFixture(state.root, state.configPath, deleteFiles);
        const originalKeeper = readKeeperStorage(fixture.keeperDatabase);
        const witnessPath = path.join(fixture.keeperWorkspace, "keeper-witness.txt");
        const originalWitness = await fs.readFile(witnessPath);
        const stateRows = (sql: string) => rows(fixture.stateDatabase, sql);
        expect(stateRows("PRAGMA user_version")).toEqual([{ user_version: 19 }]);
        expect(stateRows("PRAGMA table_info(agent_deletion_journal)")).not.toContainEqual(
          expect.objectContaining({ name: "phase" }),
        );

        const readScope = createSqliteReadOnlyWorkerScope({ signal, deadlineOwnedByCaller: false });
        let owner: ReturnType<typeof createDeletionCron> | undefined;
        const resumeDeletion = async () => {
          await captureRuntimeConfigAsyncReader()();
          owner = createDeletionCron(state, async () => {
            throw new Error("Unexpected cron dispatch in upgrade fixture");
          });
          await resumeAgentDeletions(owner.context, signal);
          expect(owner.context.logGateway.warn).not.toHaveBeenCalled();
        };
        const closeOwners = async () => {
          await owner?.stop();
          await cleanupSessionStateForTest({ stateDir: state.stateDir, rootPath: state.root });
          owner = undefined;
          resetConfigRuntimeState();
        };
        const assertKeeper = async () => {
          signal.throwIfAborted();
          const scope = { agentId: "keeper", sessionKey: fixture.keeperSessionKey, env: state.env };
          expect(loadSessionEntryReadOnly(scope)).toMatchObject({
            sessionId: fixture.keeperSessionId,
            label: "Stable keeper session",
          });
          expect(await readRecentUserAssistantTextForSession(scope)).toContainEqual(
            expect.objectContaining({ text: fixture.keeperTranscriptText }),
          );
          expect(getUserPreferences(fixture.userId)).toEqual(fixture.preferences);
          expect(await fs.readFile(witnessPath)).toEqual(originalWitness);
          const config = JSON.parse(await fs.readFile(state.configPath, "utf8"));
          expect(config.agents.entries.keeper).toEqual(fixture.config.agents.entries.keeper);
          expect(config.agents.entries.main).toEqual(fixture.config.agents.entries.main);
          expect(config.agents.defaults.model).toEqual(fixture.config.agents.defaults.model);
          expect(config.update).toEqual(fixture.config.update);
        };
        const assertClosedStorage = () => {
          expect(readKeeperStorage(fixture.keeperDatabase)).toEqual(originalKeeper);
          expectHealthySchema(fixture.keeperDatabase, OPENCLAW_AGENT_SCHEMA_VERSION);
          expectHealthySchema(fixture.stateDatabase, OPENCLAW_STATE_SCHEMA_VERSION);
          expect(stateRows("PRAGMA table_info(agent_deletion_journal)")).toContainEqual(
            expect.objectContaining({ name: "phase", type: "TEXT", notnull: 0, dflt_value: null }),
          );
        };
        try {
          await readScope.run(async () => {
            signal.throwIfAborted();
            const maintenance = await beginDoctorMaintenance({
              root: null,
              options: { repair: true, nonInteractive: true },
              runtime: {
                log: vi.fn(),
                error: vi.fn(),
                exit: () => {
                  throw new Error("Unexpected Doctor exit");
                },
              },
            });
            if (!maintenance) {
              throw new Error("Doctor did not acquire maintenance");
            }
            try {
              await maintenance.run(async () => {
                const schemas = await prepareDoctorDatabasePreflight();
                expect(schemas.pendingMigrations).toEqual(
                  expect.arrayContaining([
                    expect.objectContaining({ kind: "agent", path: fixture.keeperDatabase }),
                    expect.objectContaining({ kind: "agent", path: fixture.doomedDatabase }),
                  ]),
                );
                const pendingPaths = schemas.pendingMigrations?.map((target) => target.path) ?? [];
                await backupDoctorMigrationDatabases({
                  env: state.env,
                  databasePaths: pendingPaths,
                  pendingDatabasePaths: pendingPaths,
                });
                for (const file of [fixture.keeperDatabase, fixture.doomedDatabase]) {
                  const backups = (await fs.readdir(path.dirname(file))).filter(
                    (name) =>
                      name.startsWith(`${path.basename(file)}.pre-startup-migration-`) &&
                      name.endsWith(".bak"),
                  );
                  expect(backups).toHaveLength(1);
                  expectHealthySchema(path.join(path.dirname(file), backups[0]!), 24);
                }
                const doctor = await runDoctorConfigPreflight({
                  observe: false,
                  repairPrefixedConfig: true,
                  doctorOnlyStateMigrations: true,
                  preparePluginMetadataSnapshot: true,
                  agentDatabaseMigrationDiscovery: schemas.agentDatabaseMigrationDiscovery,
                });
                expect(
                  doctor.stateMigrationStepReceipts?.some(
                    (receipt) => receipt.outcome === "refused",
                  ),
                ).toBe(false);
                await using configDoctor = await prepareDoctorContext(state.configPath);
                await runInitialConfigWriteHealth(configDoctor);
                expect(configDoctor.configWriteRefusal).toBeUndefined();
                const migratedConfig = JSON.parse(await fs.readFile(state.configPath, "utf8"));
                expect(migratedConfig.agents.defaults).not.toHaveProperty("heartbeat");
              });
            } finally {
              await maintenance.release();
            }
            expect(rows(fixture.doomedDatabase, "PRAGMA user_version")).toEqual([
              { user_version: OPENCLAW_AGENT_SCHEMA_VERSION },
            ]);
            signal.throwIfAborted();
            const io = createConfigIO({
              configPath: state.configPath,
              env: state.env,
              homedir: () => state.home,
              observe: false,
            });
            const initialSnapshotRead = await io.readConfigFileSnapshotWithPluginMetadata();
            const startup = await loadGatewayStartupConfigSnapshot({
              initialSnapshotRead,
              minimalTestGateway: false,
              ambientEnvTriggers: "suppress",
              log: { info: vi.fn(), warn: vi.fn() },
            });
            setRuntimeConfigSnapshot(startup.snapshot.config);
            await runStartupSessionMaintenanceForTest({
              cfg: startup.snapshot.config,
              log: { info: vi.fn(), warn: vi.fn() },
            });
            expect(readAgentDeletionJournal("doomed")).toMatchObject({
              phase: "retiring",
              cleanupCompleted: false,
            });
            await assertKeeper();

            await resumeDeletion();
            signal.throwIfAborted();
            expect(readAgentDeletionJournal("doomed")).toMatchObject({
              phase: "retiring",
              cleanupCompleted: true,
            });
            expect(getRuntimeConfig().agents?.entries).not.toHaveProperty("doomed");
            for (const file of [
              fixture.doomedWorkspace,
              state.agentDir("doomed"),
              state.sessionsDir("doomed"),
              fixture.doomedDatabase,
            ]) {
              if (deleteFiles) {
                await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
              } else {
                await expect(fs.stat(file)).resolves.toBeDefined();
              }
            }
            await assertKeeper();
            await closeOwners();
            assertClosedStorage();
            if (!deleteFiles) {
              expect(rows(fixture.doomedDatabase, "SELECT session_key FROM session_nodes")).toEqual(
                [],
              );
            }

            await resumeDeletion();
            expect(readAgentDeletionJournal("doomed")).toMatchObject({ cleanupCompleted: true });
            await assertKeeper();
            await closeOwners();
            assertClosedStorage();
          });
        } finally {
          try {
            await closeOwners();
          } finally {
            await readScope.close();
          }
        }
      },
    ));
  },
);
