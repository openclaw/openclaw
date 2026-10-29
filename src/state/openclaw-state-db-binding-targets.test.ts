import { spawn } from "node:child_process";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { readGatewayLockProcessNamespace } from "../infra/gateway-lock-payload.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import { createUpdateRun } from "../infra/update-run-ledger.js";
import { VERSION } from "../version.js";
import { stateNativeProcessEntrypoints } from "./native-process-runtime.test-support.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  reconcileOpenClawStateSchemaPublication,
  repairOpenClawStateDatabaseSchema,
  prepareOpenClawStateDatabaseSchema,
} from "./openclaw-state-db.js";
import {
  addPreCutoverClientCredentialTablesForTest,
  restorePreTemplateStateIdentifiersForTest,
  withStateMigrationBackupForTest,
} from "./openclaw-state-schema.test-support.js";

// Vitest can enter teardown while a timed-out body is still closing its native owners.
const fixture = createFixtureLifetime();
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await fixture.cleanup();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  }),
);
const migrationPaths = ["runtime open", "doctor repair"] as const;
const pluginTarget = "plugin-binding:fixture:shared";

function expectVersion(db: EngineConnection, version = OPENCLAW_STATE_SCHEMA_VERSION) {
  expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: version });
}

function expectReadOnlyAdmission(db: EngineConnection) {
  expectVersion(db, 15);
  expect(db.prepare("SELECT total_changes() AS writes").get()).toEqual({ writes: 0 });
}

function readBindings(database: EngineConnection) {
  return database.prepare("SELECT * FROM current_conversation_bindings ORDER BY binding_key").all();
}

function readMigrationSnapshot(database: EngineConnection) {
  return {
    version: database.prepare("PRAGMA user_version").get(),
    metadata: database.prepare("SELECT * FROM schema_meta WHERE meta_key = 'primary'").get(),
    schema: database
      .prepare(
        "SELECT type, name, sql FROM sqlite_schema WHERE tbl_name = 'current_conversation_bindings' ORDER BY type, name",
      )
      .all(),
    rows: readBindings(database),
  };
}

function createVersion14Bindings() {
  const stateDir = tempDirs.make("openclaw-binding-targets-v14-");
  const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
  const databasePath = openOpenClawStateDatabase(options).path;
  closeOpenClawStateDatabaseForTest();

  using legacy = openNodeSqliteDatabase(databasePath);
  restorePreTemplateStateIdentifiersForTest(legacy);
  addPreCutoverClientCredentialTablesForTest(legacy);
  // A compatible future column must survive; copying only canonical columns loses its data.
  legacy.exec(`
      ALTER TABLE current_conversation_bindings ADD COLUMN target_agent_id TEXT NOT NULL DEFAULT 'main';
      ALTER TABLE current_conversation_bindings ADD COLUMN target_session_id TEXT;
      ALTER TABLE current_conversation_bindings ADD COLUMN future_note TEXT;
      DROP INDEX idx_current_conversation_bindings_target;
      CREATE INDEX idx_current_conversation_bindings_target
        ON current_conversation_bindings(target_agent_id, target_session_key, updated_at DESC, binding_key);
      PRAGMA user_version = 14;
      UPDATE schema_meta SET schema_version = 14, app_version = NULL WHERE meta_key = 'primary';
    `);
  const insert = legacy.prepare(`
      INSERT INTO current_conversation_bindings (
        binding_key, binding_id, target_agent_id, target_session_id, target_session_key,
        channel, account_id, conversation_kind, parent_conversation_id, conversation_id,
        target_kind, status, bound_at, expires_at, metadata_json, record_json, updated_at, future_note
      ) VALUES (?, ?, ?, NULL, ?, 'fixture-channel', ?, 'current', ?, ?,
                'session', 'active', 10, ?, ?, ?, 20, ?)
    `);
  for (const [conversationId, accountId, target, agent, expiresAt] of [
    ["first", "work", pluginTarget, "main", 1],
    ["second", "work", pluginTarget, "main", null],
    ["third", "personal", "agent:worker:session", "worker", 9_000_000_000_000],
  ] as const) {
    const bindingId = `generic:fixture-channel␟${accountId}␟parent␟${conversationId}`;
    const metadata = { owner: "fixture", lastActivityAt: 15 };
    insert.run(
      bindingId.slice("generic:".length),
      bindingId,
      agent,
      target,
      accountId,
      "parent",
      conversationId,
      expiresAt,
      JSON.stringify(metadata, null, 2),
      JSON.stringify({ bindingId, targetSessionKey: target, metadata }, null, 2),
      `keep:${conversationId}`,
    );
  }
  return { options, databasePath, before: readMigrationSnapshot(legacy) };
}

async function holdGatewayLifecycle(databasePath: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const ownerUrl = resolveRuntimeWorkerUrl(stateNativeProcessEntrypoints.gatewayStateOwner);
  const source = `
    import { acquireGatewayStateOwner } from ${JSON.stringify(ownerUrl.href)};
    const owner = acquireGatewayStateOwner({
      databasePath: ${JSON.stringify(databasePath)},
      payload: { pid: process.pid, processNamespace: ${JSON.stringify(readGatewayLockProcessNamespace())}, createdAt: new Date().toISOString(), configPath: "/fixture/config.json", role: "gateway" },
    });
    process.send("ready");
    process.once("message", () => { owner.release(); process.disconnect(); });
  `;
  const child = spawn(
    process.execPath,
    [...resolveRuntimeWorkerArgv(ownerUrl).slice(0, -1), "--input-type=module", "--eval", source],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
  const closed = new Promise<void>((resolve) => {
    child.once("close", () => resolve());
  });
  try {
    await withinTest(
      awaitGateBeforeSettlement(
        once(child, "message"),
        closed,
        "Gateway holder exited before readiness",
      ),
      signal,
    );
  } catch (error) {
    await fixture.verifyCleanup(async () => {
      child.kill("SIGTERM");
      await closed;
    });
    throw error;
  }
  return {
    [Symbol.asyncDispose]: () =>
      fixture.verifyCleanup(async () => {
        if (child.connected) {
          child.send("release");
        }
        await closed;
      }),
  };
}

describe("conversation binding target migration", () => {
  it("admits deferred content without schema mutation while another Gateway owns the state", ({
    signal,
  }) =>
    fixture.run(async () => {
      signal.throwIfAborted();
      const options = { env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-deferred-reader-") } };
      const initial = openOpenClawStateDatabase(options);
      const run = createUpdateRun({ trigger: "cli", before: { version: "2026.9.2" } }, options);
      initial.db
        .prepare(`INSERT INTO config_machine_state (state_key, value_json, updated_at_ms)
          VALUES ('state.schema.contentVersion', ?, ?)`)
        .run(String(OPENCLAW_STATE_SCHEMA_VERSION), Date.now());
      initial.db.exec(`PRAGMA user_version = 15;
          UPDATE schema_meta SET schema_version = 15 WHERE meta_key = 'primary';`);
      initial.db
        .prepare(`UPDATE update_runs SET status = 'succeeded', phase = 'finished',
          finished_at_ms = ? WHERE run_id = ?`)
        .run(Date.now() - 60_000, run.runId);
      closeOpenClawStateDatabaseForTest();
      {
        await using _ = await holdGatewayLifecycle(initial.path, signal);
        expect(await prepareOpenClawStateDatabaseSchema(options)).toEqual({
          changes: [],
          warnings: [],
        });
        const reader = openOpenClawStateDatabase(options);
        expectReadOnlyAdmission(reader.db);
        reader.db
          .prepare("UPDATE update_runs SET finished_at_ms = ? WHERE run_id = ?")
          .run(Date.now() - 5 * 60_000, run.runId);
        expect(() => reconcileOpenClawStateSchemaPublication(options)).not.toThrow();
        expect(openOpenClawStateDatabase(options).db).toBe(reader.db);
        expectVersion(reader.db, 15);
        closeOpenClawStateDatabaseForTest();
        expectReadOnlyAdmission(openOpenClawStateDatabase(options).db);
      }
      expectVersion(openOpenClawStateDatabase(options).db);
    }));

  it("refuses runtime and doctor schema mutation while another Gateway owns the state", ({
    signal,
  }) =>
    fixture.run(async () => {
      signal.throwIfAborted();
      const { options, databasePath } = createVersion14Bindings();
      await using _ = await holdGatewayLifecycle(databasePath, signal);
      for (const migrate of [
        () => openOpenClawStateDatabase(options),
        () => repairOpenClawStateDatabaseSchema(options),
      ]) {
        expect(migrate).toThrow(
          expect.objectContaining({
            name: "StateSchemaMutationConflictError",
            message: expect.stringContaining("another Gateway owns that state directory"),
          }),
        );
      }
      using preserved = openNodeSqliteDatabase(databasePath, { readOnly: true });
      expectVersion(preserved, 14);
    }));

  it.for(migrationPaths)(
    "preserves bindings and additive data through %s with backup custody and cold reopen under a Gateway",
    (migrationPath, { signal }) =>
      fixture.run(async () => {
        signal.throwIfAborted();
        const { options, databasePath, before } = createVersion14Bindings();
        await withStateMigrationBackupForTest(options, () => {
          if (migrationPath === "doctor repair") {
            expect(repairOpenClawStateDatabaseSchema(options).warnings).toEqual([]);
          } else {
            openOpenClawStateDatabase(options);
          }
        });
        const migrated = openOpenClawStateDatabase(options);
        const after = readMigrationSnapshot(migrated.db);
        expect(after.rows).toEqual(
          before.rows.map(
            ({ target_agent_id: _agent, target_session_id: _session, ...row }) => row,
          ),
        );
        expectVersion(migrated.db);
        expect(after.metadata).toMatchObject({
          schema_version: OPENCLAW_STATE_SCHEMA_VERSION,
          app_version: migrationPath === "runtime open" ? VERSION : null,
        });
        expect(
          migrated.db
            .prepare(
              "SELECT name, \"unique\" FROM pragma_index_list('current_conversation_bindings') WHERE name = 'idx_current_conversation_bindings_target'",
            )
            .get(),
        ).toEqual({ name: "idx_current_conversation_bindings_target", unique: 0 });
        const query =
          "SELECT binding_id FROM current_conversation_bindings WHERE target_session_key = ?";
        expect(migrated.db.prepare(query).all(pluginTarget)).toHaveLength(2);
        expect(
          migrated.db
            .prepare(`EXPLAIN QUERY PLAN ${query}`)
            .all(pluginTarget)
            .map((row) => row.detail),
        ).toEqual([
          expect.stringMatching(
            /SEARCH current_conversation_bindings USING INDEX idx_current_conversation_bindings_target \(target_session_key=\?\)/,
          ),
        ]);
        expect(migrated.db.prepare("PRAGMA integrity_check").get()).toEqual({
          integrity_check: "ok",
        });
        expect(migrated.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);

        closeOpenClawStateDatabaseForTest();
        {
          await using _ = await holdGatewayLifecycle(databasePath, signal);
          using cachedCleanup = new DisposableStack();
          cachedCleanup.defer(closeOpenClawStateDatabaseForTest);
          expect(readMigrationSnapshot(openOpenClawStateDatabase(options).db)).toEqual(after);
        }
        expect(repairOpenClawStateDatabaseSchema(options).warnings).toEqual([]);
        using repaired = openNodeSqliteDatabase(databasePath, { readOnly: true });
        expect(readBindings(repaired)).toEqual(after.rows);
        expect(readMigrationSnapshot(repaired).schema).toEqual(after.schema);
      }),
  );

  it.each(
    migrationPaths.flatMap((migrationPath) =>
      (["dependent trigger", "owner mismatch"] as const).map((failure) => ({
        migrationPath,
        failure,
      })),
    ),
  )(
    "preserves the complete old database after $failure through $migrationPath",
    async ({ migrationPath, failure }) => {
      const { options, databasePath } = createVersion14Bindings();
      let before: ReturnType<typeof readMigrationSnapshot>;
      {
        using legacy = openNodeSqliteDatabase(databasePath);
        if (failure === "dependent trigger") {
          // The second DROP must fail after the first column and target index were removed.
          legacy.exec(`CREATE TRIGGER fixture_binding_session_guard
          AFTER UPDATE ON current_conversation_bindings
          BEGIN SELECT OLD.target_session_id; END;`);
        } else {
          legacy.exec("UPDATE schema_meta SET role = 'agent' WHERE meta_key = 'primary';");
        }
        before = readMigrationSnapshot(legacy);
      }
      const reason = failure === "dependent trigger" ? /target_session_id/ : /expected global/;
      await withStateMigrationBackupForTest(options, () => {
        if (migrationPath === "runtime open") {
          expect(() => openOpenClawStateDatabase(options)).toThrow(reason);
        } else {
          expect(repairOpenClawStateDatabaseSchema(options)).toEqual({
            changes: [],
            warnings: [expect.stringMatching(reason)],
          });
        }
      });
      using preserved = openNodeSqliteDatabase(databasePath, { readOnly: true });
      expect(readMigrationSnapshot(preserved)).toEqual(before);
    },
  );
});
