import fs from "node:fs";
import path from "node:path";
import { getEnvironmentData } from "node:worker_threads";
import { expectDefined } from "@openclaw/normalization-core/expect";
import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withEngineStoreAdmission } from "../infra/database-engine/admission-scope.js";
import * as engineOpen from "../infra/database-engine/open.js";
import { getPostgresPhysicalFacts } from "../infra/database-engine/physical-facts.js";
import { acquireGatewayLock } from "../infra/gateway-lock.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { isPostgresSqlConnection, type PostgresSqlConnection } from "../infra/sql-connection.js";
import * as readOnlyWorker from "../infra/sqlite-readonly-worker.js";
import { readMeetingTranscriptMigrationDetectionState } from "../infra/state-migrations.meeting-transcripts-detection.js";
import * as generationInspection from "../infra/update-candidate-state.inspection.js";
import { createUpdateDoctorDatabaseWriteCapture } from "../infra/update-doctor-result.js";
import { readActiveOpenClawAgentDatabaseLeasesReadOnly } from "./openclaw-agent-db-lease-inspection.js";
import { openClawStateDatabaseCache } from "./openclaw-state-db-cache.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import { openDoctorStateSchemaReadAdmission } from "./openclaw-state-db-doctor-schema.js";
import {
  executeExistingOpenClawStateRead,
  withArtifactPreservingStateReads,
  withOpenClawStateDatabaseReadSnapshot,
} from "./openclaw-state-db-readonly.js";
import { ensureAgentDatabaseLeaseSchema } from "./openclaw-state-db-schema-additive.js";
import {
  closeOpenClawStateDatabaseAsync,
  detectOpenClawStateDatabaseSchemaMigrations,
  openOpenClawStateDatabase,
  openOpenClawStateDatabaseForDoctor,
  prepareOpenClawStateDatabaseSchema,
  repairOpenClawStateDatabaseIndexesForDoctor,
  repairOpenClawStateDatabaseReadabilityForDoctor,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";
import {
  cleanupPostgresStateFixture,
  installPostgresStateFixture,
  readPostgresStateFixtureArtifacts as readStateArtifacts,
} from "./openclaw-state-db.postgres-fixture.test-support.js";

const configured: unknown = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection = typeof configured === "string" ? configured : undefined;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe.skipIf(!connection)("PostgreSQL shared-state opening", () => {
  it("reads warm and cold discovery state without copying or changing the PostgreSQL anchor", async () => {
    const directory = tempDirs.make("state-discovery-postgres-");
    const env = { ...process.env, OPENCLAW_STATE_DIR: directory };
    const pathname = resolveOpenClawStateSqlitePath(env);
    const options = { path: pathname, env };
    const client = new pg.Client({ connectionString: connection });
    await client.connect();
    installPostgresStateFixture(connection!, "state_discovery_conformance");
    let namespace: string | undefined;
    const stateKey = "discovery.fixture";
    const valueJson = JSON.stringify({ source: "PostgreSQL" });
    try {
      namespace = withEngineStoreAdmission(() =>
        runOpenClawStateWriteTransaction(({ db }) => {
          ensureAgentDatabaseLeaseSchema(db);
          db.exec(`INSERT INTO migration_runs (id, started_at, status, report_json)
            VALUES ('meeting-import', 1, 'imported', '{}');
            INSERT INTO migration_sources
            (source_key, migration_kind, source_path, target_table, last_run_id, status, imported_at, report_json)
            VALUES ('meeting-import', 'meeting-transcripts-files-v1', 'synthetic', 'meeting_transcript_sessions', 'meeting-import', 'imported', 1, '{}');`);
          db.prepare(
            "INSERT INTO agent_database_leases (lease_id, agent_id, path, owner_pid, owner_start_time, opened_at) VALUES (?, ?, ?, ?, NULL, ?)",
          ).run("diagnostic-lease", "main", path.join(directory, "agent.sqlite"), process.pid, 1);
          db.prepare(
            "INSERT INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES (?, ?, ?)",
          ).run(stateKey, valueJson, 1);
          return expectDefined(getPostgresPhysicalFacts(db), "PostgreSQL fixture").namespace;
        }, options),
      );
      const artifacts = readStateArtifacts(directory, pathname);
      let prepared: Promise<{ changes: string[]; warnings: string[] }> | undefined;
      const repairs: Array<ReturnType<typeof repairOpenClawStateDatabaseIndexesForDoctor>> = [];
      withEngineStoreAdmission(() => {
        prepared = prepareOpenClawStateDatabaseSchema(options, "doctor-preparation");
        for (const repair of [
          repairOpenClawStateDatabaseIndexesForDoctor,
          repairOpenClawStateDatabaseReadabilityForDoctor,
        ]) {
          repairs.push(repair(options));
        }
      });
      expect(await prepared).toEqual({ changes: [], warnings: [] });
      for (const repair of repairs) {
        expect(await repair).toEqual({ changes: [], warnings: [] });
      }
      for (const source of ["warm", "cold"]) {
        if (source === "cold") {
          await closeOpenClawStateDatabaseAsync();
        }
        withEngineStoreAdmission(() => {
          expect(detectOpenClawStateDatabaseSchemaMigrations(options)).toEqual([]);
        });
        for (const artifactPreservingReadOnly of [false, true]) {
          expect(
            (
              await readMeetingTranscriptMigrationDetectionState({
                env,
                artifactPreservingReadOnly,
              })
            ).pendingImportCount,
          ).toBe(1);
        }
        expect(
          (
            await readActiveOpenClawAgentDatabaseLeasesReadOnly(
              options,
              openDoctorStateSchemaReadAdmission,
            )
          ).map((row) => row.lease_id),
        ).toEqual(["diagnostic-lease"]);
        const reply = await withArtifactPreservingStateReads(() =>
          withOpenClawStateDatabaseReadSnapshot(
            () =>
              executeExistingOpenClawStateRead(options, { type: "tui.lastSession.read", stateKey }),
            options,
          ),
        );
        expect(reply?.row).toEqual({ value_json: valueJson, updated_at_ms: 1 });
        expect(readStateArtifacts(directory, pathname)).toEqual(artifacts);
      }
      using anchor = openNodeSqliteDatabase(pathname, { readOnly: true });
      expect(
        anchor.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all(),
      ).toEqual([{ name: "openclaw_engine_anchor" }]);
    } finally {
      await closeOpenClawStateDatabaseAsync();
      await cleanupPostgresStateFixture(client, pathname, namespace);
    }
  });

  it("closes an unpublished PostgreSQL writer when its post-open credential observation is cancelled", async () => {
    const directory = tempDirs.make("state-postgres-open-cancellation-");
    const env = {
      ...process.env,
      OPENCLAW_STATE_DIR: directory,
      OPENCLAW_CONFIG_PATH: path.join(directory, "openclaw.json"),
    };
    fs.writeFileSync(
      env.OPENCLAW_CONFIG_PATH,
      JSON.stringify({ database: { engine: "postgres", postgres: { connection } } }),
    );
    const pathname = resolveOpenClawStateSqlitePath(env);
    const credentialPath = path.join(directory, "client", "credentials.sqlite");
    const options = { path: pathname, env };
    installPostgresStateFixture(connection!, "state_open_cancellation");
    const client = new pg.Client({ connectionString: connection });
    await client.connect();
    let namespace: string | undefined;
    let acquired: PostgresSqlConnection | undefined;
    const opened: PostgresSqlConnection[] = [];
    const cancellation = new AbortController();
    const interrupted = new Error("Cancelled after PostgreSQL opened before capture publication");
    let release: (() => Promise<void>) | undefined;
    try {
      namespace = withEngineStoreAdmission(() =>
        runOpenClawStateWriteTransaction(({ db }) => {
          db.prepare(
            "INSERT INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES (?, ?, ?)",
          ).run("cancelled-open-proof", '"retained"', 1);
          return expectDefined(getPostgresPhysicalFacts(db), "PostgreSQL fixture").namespace;
        }, options),
      );
      await closeOpenClawStateDatabaseAsync();
      const generations = await generationInspection.readUpdateDatabaseGenerationsIsolated(
        [credentialPath],
        { env },
      );
      const lock = expectDefined(
        await acquireGatewayLock({
          env,
          allowInTests: true,
          role: "sqlite-maintenance",
          timeoutMs: 0,
        }),
        "PostgreSQL open maintenance owner",
      );
      release = () => lock.release();
      const capture = expectDefined(
        createUpdateDoctorDatabaseWriteCapture(generations, {
          env,
          signal: new AbortController().signal,
          assertCurrent: () => lock.assertCurrent(),
          warn: vi.fn(),
        }),
        "Credential migration capture",
      );
      const nativeOpen = engineOpen.openEngineStore;
      const native = vi.spyOn(engineOpen, "openEngineStore").mockImplementation((...args) => {
        const db = nativeOpen(...args);
        if (args[0].anchor.location() === pathname && isPostgresSqlConnection(db)) {
          acquired = db;
          opened.push(db);
        }
        return db;
      });
      const inspect = generationInspection.readUpdateSqliteDatabaseGenerationPairIsolated;
      const observation = vi
        .spyOn(generationInspection, "readUpdateSqliteDatabaseGenerationPairIsolated")
        .mockImplementation(async (...args) => {
          const result = await inspect(...args);
          if (
            args[0].includes(credentialPath) &&
            acquired?.isOpen &&
            !cancellation.signal.aborted
          ) {
            cancellation.abort(interrupted);
          }
          return result;
        });
      try {
        await lock.run(async () => {
          await capture.admit();
          await capture.run(async () => {
            const open = () =>
              openOpenClawStateDatabaseForDoctor({
                ...options,
                clientCredentialMigrationFromVersion: OPENCLAW_STATE_SCHEMA_VERSION,
              });
            await expect(
              readOnlyWorker.withSqliteReadOnlyWorkerScope(open, {
                signal: cancellation.signal,
                deadlineOwnedByCaller: false,
              }),
            ).rejects.toBe(interrupted);
            const refused = expectDefined(acquired, "Opened PostgreSQL writer");
            expect(refused.isOpen).toBe(false);
            expect(refused.anchor.isOpen).toBe(false);
            expect(
              openClawStateDatabaseCache.getOpenClawStateDatabaseIfOpenAtPath(pathname),
            ).toBeUndefined();
            const successor = await readOnlyWorker.withSqliteReadOnlyWorkerScope(open);
            expect(successor.db).not.toBe(refused);
            const reads = observation.mock.calls.length;
            expect(withEngineStoreAdmission(() => openOpenClawStateDatabase(options))).toBe(
              successor,
            );
            expect(observation).toHaveBeenCalledTimes(reads);
            expect(
              (
                await client.query(
                  `SELECT value_json FROM "${namespace}".config_machine_state WHERE state_key = 'cancelled-open-proof'`,
                )
              ).rows,
            ).toEqual([{ value_json: '"retained"' }]);
          });
        });
      } finally {
        native.mockRestore();
        observation.mockRestore();
      }
    } finally {
      await closeOpenClawStateDatabaseAsync();
      for (const db of opened) {
        withEngineStoreAdmission(() => db.close());
        if (db.anchor.isOpen) {
          db.anchor.close();
        }
      }
      await release?.();
      await cleanupPostgresStateFixture(client, pathname, namespace);
    }
  });
});
