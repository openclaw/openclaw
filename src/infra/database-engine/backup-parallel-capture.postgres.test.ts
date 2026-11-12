import assert from "node:assert/strict";
import "../../test-utils/prepare-compiled-subprocesses.js";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { getEnvironmentData } from "node:worker_threads";
import { Client } from "pg";
import { describe, expect, it, vi } from "vitest";
import { clearRuntimeConfigSnapshot } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../../state/openclaw-agent-db-contract.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../../state/openclaw-state-db-contract.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createBackupArchive } from "../backup-create.js";
import * as scratchModule from "../backup-scratch.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import * as sqliteSnapshot from "../sqlite-snapshot.js";
import { WorkerTaskPool } from "../worker-task-pool.js";
import { resetDatabaseEngineSelectionForTest } from "./context.test-support.js";
import { loadDatabasePortDescriptor } from "./port-provider-descriptor.js";
import { materializeDatabasePort } from "./port.worker.js";

const configured = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection = typeof configured === "string" ? configured : undefined;

describe.skipIf(!connection)("parallel backup capture with the PostgreSQL export worker", () => {
  // One PostgreSQL store: this covers abort and join with the real worker. Exports of several
  // PostgreSQL stores are serialized; matrix-roots.postgres.test.ts covers that path.
  it("joins the real export worker before scratch cleanup when a SQLite capture fails", async () => {
    assert(connection);
    await withEnvAsync({ OPENCLAW_PARALLEL_CAPTURE_TEST_PG: connection }, async () => {
      await withOpenClawTestState(
        { scenario: "minimal", prefix: "pg-parallel-" },
        async (state) => {
          const database = `parallel_capture_${randomUUID().replaceAll("-", "")}`;
          const isolated = new URL(connection);
          isolated.pathname = `/${database}`;
          process.env.OPENCLAW_PARALLEL_CAPTURE_TEST_PG = isolated.href;
          const admin = new Client({ connectionString: connection });
          const client = new Client({ connectionString: isolated.href });
          const config: OpenClawConfig = {
            database: {
              engine: "postgres",
              families: { agent: { engine: "sqlite" } },
              postgres: {
                connection: {
                  source: "env",
                  provider: "default",
                  id: "OPENCLAW_PARALLEL_CAPTURE_TEST_PG",
                },
              },
            },
            agents: { defaults: { workspace: state.path("workspace") }, entries: { main: {} } },
            plugins: {
              entries: {
                workboard: { enabled: false },
                logbook: { enabled: false },
                "team-reports": { enabled: false },
                matrix: { enabled: false },
              },
            },
          };
          await state.writeConfig(config);
          const statePath = state.statePath("state", "openclaw.sqlite");
          const agentPath = state.statePath("agents", "main", "agent", "openclaw-agent.sqlite");
          const timeline: string[] = [];
          await admin.connect();
          try {
            await admin.query(`CREATE DATABASE "${database}"`);
            await client.connect();
            await client.query(
              "CREATE EXTENSION vector; CREATE EXTENSION pg_trgm; CREATE EXTENSION unaccent",
            );
            const stateDescriptor = await loadDatabasePortDescriptor("state", config);
            const namespace = `parallel_${randomUUID().replaceAll("-", "")}`;
            const storeId = randomUUID();
            await fs.mkdir(path.dirname(statePath), { recursive: true });
            {
              using source = openNodeSqliteDatabase(":memory:");
              source.exec(stateDescriptor.sqlite);
              for (const fragment of stateDescriptor.fragments ?? []) {
                source.exec(fragment.sqlite);
              }
              source.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION};
              INSERT INTO schema_meta VALUES ('primary', 'global', ${OPENCLAW_STATE_SCHEMA_VERSION}, NULL, NULL, 1, 1);
              INSERT INTO config_machine_state VALUES ('state.schema.contentVersion', '${OPENCLAW_STATE_SCHEMA_VERSION}', 1);`);
              // Enough rows that the export is still running when the SQLite capture fails.
              const insert = source.prepare(
                "INSERT INTO plugin_state_entries (plugin_id, namespace, entry_key, value_json, created_at) VALUES ('proof', 'bulk', ?, ?, 1)",
              );
              const value = JSON.stringify("x".repeat(2048));
              source.exec("BEGIN");
              for (let index = 0; index < 20_000; index += 1) {
                insert.run(`entry-${index}`, value);
              }
              source.exec("COMMIT");
              await materializeDatabasePort({
                source: { engine: "sqlite", db: source },
                destination: { engine: "postgres", db: client, namespace },
                descriptor: stateDescriptor,
                storeId,
                assertCurrent() {},
              });
            }
            {
              using anchor = openNodeSqliteDatabase(statePath);
              anchor.exec(
                "CREATE TABLE openclaw_engine_anchor (store_id TEXT NOT NULL, engine TEXT NOT NULL, schema TEXT NOT NULL)",
              );
              anchor
                .prepare("INSERT INTO openclaw_engine_anchor VALUES (?, 'postgres', ?)")
                .run(storeId, namespace);
            }
            const agentDescriptor = await loadDatabasePortDescriptor("agent", config);
            await fs.mkdir(path.dirname(agentPath), { recursive: true });
            {
              using agent = openNodeSqliteDatabase(agentPath);
              agent.exec(agentDescriptor.sqlite);
              agent.exec(`PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION};
              INSERT INTO schema_meta VALUES ('primary', 'agent', ${OPENCLAW_AGENT_SCHEMA_VERSION}, 'main', NULL, 1, 1);
              INSERT INTO session_key_contract (id, main_key, updated_at) VALUES (1, 'main', 0);`);
            }
            resetDatabaseEngineSelectionForTest();
            clearRuntimeConfigSnapshot();

            const clientPid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
            // Only the export worker connects to the isolated database besides this client.
            const exportBackends = async () =>
              Number(
                (
                  await admin.query(
                    "SELECT count(*) AS n FROM pg_stat_activity WHERE datname = $1 AND pid <> $2",
                    [database, clientPid],
                  )
                ).rows[0].n,
              );
            let workerStarted!: () => void;
            const started = new Promise<void>((resolve) => {
              workerStarted = resolve;
            });
            // oxlint-disable-next-line typescript/unbound-method -- Called with the intercepted pool receiver.
            const run = WorkerTaskPool.prototype.run;
            vi.spyOn(WorkerTaskPool.prototype, "run").mockImplementation(function (
              this: WorkerTaskPool<unknown, unknown>,
              ...args: Parameters<typeof run>
            ) {
              // Backup discovery uses a worker too; only the store export is followed.
              if ((args[0] as { operation?: string }).operation !== "capture") {
                return run.apply(this, args);
              }
              timeline.push("export worker run started");
              const close = this.close.bind(this);
              // The join is the pool close that runBackupTask awaits before rethrowing.
              this.close = async (...closeArgs: Parameters<typeof close>) => {
                timeline.push("export worker close called");
                await close(...closeArgs);
                timeline.push("export worker joined");
              };
              workerStarted();
              return run.apply(this, args).then(
                (result) => {
                  timeline.push("export worker run resolved");
                  return result;
                },
                (error: unknown) => {
                  timeline.push("export worker run rejected");
                  throw error;
                },
              );
            });
            const snapshot = sqliteSnapshot.createVerifiedSqliteSnapshot;
            vi.spyOn(sqliteSnapshot, "createVerifiedSqliteSnapshot").mockImplementation(
              async (params) => {
                if (path.resolve(params.sourcePath) === (await fs.realpath(agentPath))) {
                  await started;
                  // Fail only once the worker is connected and exporting from PostgreSQL.
                  for (let attempt = 0; (await exportBackends()) === 0; attempt += 1) {
                    assert(attempt < 400, "export worker never connected");
                    await delay(25);
                  }
                  timeline.push("sqlite capture failed while export active");
                  throw new Error("synthetic SQLite capture failure");
                }
                return snapshot(params);
              },
            );
            let scratchDirectory: string | undefined;
            const createScratch = scratchModule.createBackupScratchDirectory;
            vi.spyOn(scratchModule, "createBackupScratchDirectory").mockImplementation(
              async (root) => {
                const scratch = await createScratch(root);
                scratchDirectory = scratch.directory;
                return scratch;
              },
            );
            const finish = scratchModule.finishBackupScratch;
            vi.spyOn(scratchModule, "finishBackupScratch").mockImplementation(async (...args) => {
              // The server ends a backend shortly after the joined worker's socket closes.
              let backends = await exportBackends();
              for (let attempt = 0; backends > 0 && attempt < 40; attempt += 1) {
                await delay(25);
                backends = await exportBackends();
              }
              timeline.push(`scratch cleanup started (export backends: ${backends})`);
              const result = await finish(...args);
              timeline.push("scratch cleanup finished");
              return result;
            });

            await expect(
              createBackupArchive({ output: state.path("archive.tar.gz") }),
            ).rejects.toThrow("synthetic SQLite capture failure");
            timeline.push("createBackupArchive rejected");
            assert(scratchDirectory);
            // Any write after cleanup would have to recreate the scratch directory.
            for (let check = 0; check < 20; check += 1) {
              await expect(fs.lstat(scratchDirectory)).rejects.toMatchObject({ code: "ENOENT" });
              await delay(50);
            }

            expect(timeline).toEqual([
              "export worker run started",
              "sqlite capture failed while export active",
              "export worker run rejected",
              "export worker close called",
              "export worker joined",
              "scratch cleanup started (export backends: 0)",
              "scratch cleanup finished",
              "createBackupArchive rejected",
            ]);
          } finally {
            vi.restoreAllMocks();
            await closeStateDatabaseForTest();
            resetDatabaseEngineSelectionForTest();
            await client.end().catch(() => undefined);
            try {
              await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
            } finally {
              await admin.end();
            }
          }
        },
      );
    });
  });
});
