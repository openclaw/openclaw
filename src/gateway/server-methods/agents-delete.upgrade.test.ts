// Prepare declared workers during collection, outside the scenario deadline.
import "../server-start.js";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { createAgent } from "../../agents/agent-create.js";
import { runDoctorConfigPreflight } from "../../commands/doctor-config-preflight.js";
import { prepareDoctorDatabasePreflight } from "../../commands/doctor-database-preflight.js";
import { beginDoctorMaintenance } from "../../commands/doctor-maintenance.js";
import { backupDoctorMigrationDatabases } from "../../commands/doctor-migration-backup.js";
import { createConfigIO, getRuntimeConfig, resetConfigRuntimeState } from "../../config/config.js";
import {
  loadSessionEntryReadOnly,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.sqlite-entry.js";
import { readRecentUserAssistantTextForSession } from "../../config/sessions/transcript.js";
import { CronService } from "../../cron/service.js";
import { createSqliteReadOnlyWorkerScope } from "../../infra/sqlite-readonly-worker.js";
import { readAgentDeletionJournal } from "../../state/agent-deletion-journal.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../../state/openclaw-agent-db.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../../state/openclaw-state-db-contract.js";
import { getUserPreferences } from "../../state/user-preferences.test-support.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { resumeAgentDeletions } from "../server-agent-deletion-recovery.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { loadGatewayStartupConfigSnapshot } from "../server-startup-config-helpers.js";
import { runStartupSessionMaintenanceForTest } from "../server-startup-session-migration.test-support.js";
import { seedLegacyAgentDeletionFixture } from "./legacy-agent-deletion-fixture.test-support.js";

let scenarioWork: Promise<void> | undefined;
afterEach(async () => {
  // Join a timed-out body before another fixture changes process.env.
  await scenarioWork;
  scenarioWork = undefined;
});

function readDatabase<T>(file: string, read: (database: DatabaseSync) => T): T {
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    return read(database);
  } finally {
    database.close();
  }
}

function readKeeperStorage(file: string) {
  return readDatabase(file, (database) => ({
    entries: database
      .prepare(
        "SELECT session_key, current_session_id, entry_json FROM session_nodes ORDER BY session_key",
      )
      .all(),
    transcripts: database
      .prepare(
        "SELECT session_id, seq, event_json, hex(event_zstd) AS compressed, event_utf8_bytes FROM transcript_events ORDER BY session_id, seq",
      )
      .all(),
  }));
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
          OPENCLAW_TEST_MINIMAL_GATEWAY: "0",
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
          OPENCLAW_SKIP_PROVIDERS: "1",
          OPENCLAW_SKIP_CHANNELS: "1",
          OPENCLAW_SKIP_CRON: "1",
          OPENCLAW_SKIP_GMAIL_WATCHER: "1",
          OPENCLAW_SKIP_CANVAS_HOST: "1",
          OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
          OPENCLAW_DISABLE_BONJOUR: "1",
        },
      },
      async (state) => {
        const fixture = seedLegacyAgentDeletionFixture(state.root, state.configPath, deleteFiles);
        const originalKeeper = readKeeperStorage(fixture.keeperDatabase);
        const witnessPath = path.join(fixture.keeperWorkspace, "keeper-witness.txt");
        const originalWitness = await fs.readFile(witnessPath);
        readDatabase(fixture.stateDatabase, (database) => {
          expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(19);
          expect(
            database.prepare("SELECT app_version FROM schema_meta WHERE meta_key = 'primary'").get()
              ?.app_version,
          ).toBe("2026.9.9");
          expect(
            database.prepare("PRAGMA table_info(agent_deletion_journal)").all(),
          ).not.toContainEqual(expect.objectContaining({ name: "phase" }));
          expect(
            database
              .prepare(
                "SELECT agent_id, cleanup_completed, delete_files FROM agent_deletion_journal",
              )
              .all(),
          ).toEqual([
            { agent_id: "doomed", cleanup_completed: 0, delete_files: Number(deleteFiles) },
          ]);
        });
        for (const file of [fixture.keeperDatabase, fixture.doomedDatabase]) {
          expect(
            readDatabase(
              file,
              (database) => database.prepare("PRAGMA user_version").get()?.user_version,
            ),
          ).toBe(24);
        }

        const readScope = createSqliteReadOnlyWorkerScope({ signal, deadlineOwnedByCaller: false });
        let scheduler: ReturnType<typeof createTestGatewayScheduler> | undefined;
        let cron: CronService | undefined;
        const startRecoveryOwner = () => {
          scheduler = createTestGatewayScheduler();
          cron = new CronService({
            scheduler,
            storePath: path.join(state.stateDir, "cron", "jobs.json"),
            cronEnabled: false,
            log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
            enqueueSystemEvent: vi.fn(),
            requestHeartbeat: vi.fn(),
            runIsolatedAgentJob: async () => {
              throw new Error("Unexpected cron dispatch in upgrade fixture");
            },
          });
          return createDirectChatContext({ cron, getRuntimeConfig });
        };
        const closeOwners = async () => {
          cron?.stop();
          await cron?.waitForIdle();
          await scheduler?.stop();
          await cleanupSessionStateForTest({ stateDir: state.stateDir, rootPath: state.root });
          cron = undefined;
          scheduler = undefined;
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
          readDatabase(fixture.keeperDatabase, (database) => {
            expect(database.prepare("PRAGMA integrity_check").all()).toEqual([
              { integrity_check: "ok" },
            ]);
            expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(
              OPENCLAW_AGENT_SCHEMA_VERSION,
            );
          });
          readDatabase(fixture.stateDatabase, (database) => {
            expect(database.prepare("PRAGMA integrity_check").all()).toEqual([
              { integrity_check: "ok" },
            ]);
            expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(
              OPENCLAW_STATE_SCHEMA_VERSION,
            );
            expect(
              database.prepare("PRAGMA table_info(agent_deletion_journal)").all(),
            ).toContainEqual(
              expect.objectContaining({
                name: "phase",
                type: "TEXT",
                notnull: 0,
                dflt_value: null,
              }),
            );
          });
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
                  readDatabase(path.join(path.dirname(file), backups[0]!), (database) => {
                    expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(24);
                    expect(database.prepare("PRAGMA integrity_check").all()).toEqual([
                      { integrity_check: "ok" },
                    ]);
                  });
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
              });
            } finally {
              await maintenance.release();
            }
            expect(
              readDatabase(
                fixture.doomedDatabase,
                (database) => database.prepare("PRAGMA user_version").get()?.user_version,
              ),
            ).toBe(OPENCLAW_AGENT_SCHEMA_VERSION);
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
            await runStartupSessionMaintenanceForTest({
              cfg: startup.snapshot.config,
              log: { info: vi.fn(), warn: vi.fn() },
            });
            expect(readAgentDeletionJournal("doomed")).toMatchObject({
              phase: "retiring",
              cleanupCompleted: false,
            });
            await assertKeeper();

            let context = startRecoveryOwner();
            await resumeAgentDeletions(context, signal);
            signal.throwIfAborted();
            expect(context.logGateway.warn).not.toHaveBeenCalled();
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
              expect(
                readDatabase(fixture.doomedDatabase, (database) =>
                  database.prepare("SELECT session_key FROM session_nodes").all(),
                ),
              ).toEqual([]);
            }

            context = startRecoveryOwner();
            await resumeAgentDeletions(context, signal);
            expect(context.logGateway.warn).not.toHaveBeenCalled();
            expect(readAgentDeletionJournal("doomed")).toMatchObject({ cleanupCompleted: true });
            await assertKeeper();
            expect(
              await createAgent({
                name: "doomed",
                workspace: fixture.doomedWorkspace,
                skipBootstrap: true,
              }),
            ).toMatchObject({ status: "created", agentId: "doomed" });
            expect(readAgentDeletionJournal("doomed")).toBeUndefined();
            await expect(
              replaceSessionEntry(
                { agentId: "doomed", sessionKey: "agent:doomed:recreated", env: state.env },
                { sessionId: "recreated-after-upgrade", updatedAt: 2 },
              ),
            ).resolves.toMatchObject({ sessionId: "recreated-after-upgrade" });
            await assertKeeper();
            await closeOwners();
            assertClosedStorage();
            readDatabase(fixture.doomedDatabase, (database) => {
              expect(database.prepare("PRAGMA integrity_check").all()).toEqual([
                { integrity_check: "ok" },
              ]);
            });
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
