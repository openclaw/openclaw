import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import {
  listSessionPendingInputs,
  readSessionPendingInput,
  stageSessionPendingInput,
} from "../config/sessions/session-accessor.pending-inputs.js";
import { runSessionStartupMigration } from "../config/sessions/startup-migration-runtime.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { assertSqliteSchemaContains } from "../infra/sqlite-schema-contract.test-support.js";
import { admitSqliteSchema } from "../infra/sqlite-schema-facts.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { requireNativeSqliteDatabase } from "../test-utils/native-sqlite.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import { canonicalSessionValidationSchemaSql } from "./openclaw-agent-canonical-validation-schema.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "./openclaw-agent-db-contract.js";
import { withAgentDatabaseMaintenanceLease } from "./openclaw-agent-db-maintenance-lease.js";
import { migrateOpenClawAgentDatabaseForMaintenance } from "./openclaw-agent-db-maintenance.js";
import { ensureOpenClawAgentDatabaseSchema } from "./openclaw-agent-db-schema.js";
import {
  closeOpenClawAgentDatabasesForTest,
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "./openclaw-agent-db.js";
import { migrateAgentPendingInputEndingsInTransaction } from "./openclaw-agent-pending-input-endings-schema.js";
import {
  ensureSessionPendingInputsSchema,
  ensureSessionInputCompletionsSchema,
  hasSessionPendingInputsSchema,
} from "./openclaw-agent-pending-inputs-schema.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";
import {
  assertOpenClawMigrationWitnessPreserved,
  captureOpenClawMigrationWitness,
} from "./openclaw-migration-witness.js";
import {
  expectRow,
  expectRows,
  readRow,
  readRows,
} from "./openclaw-state-db-fixtures.test-support.js";
import { tableHasColumn, tableExists } from "./openclaw-state-db-schema-helpers.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-input-schema-");
const fixture = () => ({ agentId: "main", env: { OPENCLAW_STATE_DIR: sessionDirs.make() } });
async function closeAgents() {
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
}
async function previousDatabase(filename: string) {
  await closeAgents();
  fs.copyFileSync(filename, `${filename}.previous`);
  fs.renameSync(`${filename}.previous`, filename);
  return new DatabaseSync(filename);
}
async function migratePreviousDatabase(
  options: { agentId: string; env: NodeJS.ProcessEnv },
  pathname: string,
) {
  await withAgentDatabaseMaintenanceLease(options, (maintenance) =>
    migrateOpenClawAgentDatabaseForMaintenance({ ...options, pathname }, maintenance),
  );
}
async function stage(
  scope: Parameters<typeof stageSessionPendingInput>[0],
  runId: string,
  content: string,
) {
  const receipt = await stageSessionPendingInput(scope, {
    runId,
    message: { role: "user", content, timestamp: 1, idempotencyKey: `${runId}:user` },
    assertCurrent() {},
  });
  receipt!.finish("interrupted", "failed");
  await receipt!.settled?.();
  return receipt!;
}
const metadataSql = "SELECT schema_version, updated_at FROM schema_meta WHERE meta_key = 'primary'";

describe("pending input additive schema", () => {
  it("installs the completion cascade index once through first-use schema facts", () => {
    using database = openNodeSqliteDatabase(":memory:");
    database.exec(OPENCLAW_AGENT_SCHEMA_SQL);
    database.exec("DROP INDEX IF EXISTS idx_agent_session_input_completions_session_key");
    admitSqliteSchema(database);
    ensureSessionInputCompletionsSchema(database);
    expect(
      database
        .prepare("EXPLAIN QUERY PLAN DELETE FROM session_nodes WHERE session_key=?")
        .all("missing"),
    ).not.toContainEqual(expect.objectContaining({ detail: "SCAN session_input_completions" }));
    const exec = vi.spyOn(database, "exec");
    try {
      ensureSessionInputCompletionsSchema(database);
      expect(exec).not.toHaveBeenCalled();
    } finally {
      exec.mockRestore();
    }
  });

  it("migrates version 42 user endings atomically on schema admission without rewriting messages", async () => {
    const options = fixture();
    const scope = {
      ...options,
      sessionKey: "agent:main:test",
      sessionId: "test",
    };
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    const filename = openOpenClawAgentDatabase(options).path;
    const database = await previousDatabase(filename);
    database.exec(`
      ALTER TABLE session_members DROP COLUMN access;
      ALTER TABLE session_pending_inputs DROP COLUMN end_cause;
      ALTER TABLE session_pending_inputs DROP COLUMN origin_source_json;
      ALTER TABLE session_nodes DROP COLUMN archive_undo_marker;
      PRAGMA user_version = 42;
      UPDATE schema_meta SET schema_version = 42 WHERE meta_key = 'primary';
    `);
    const messages = [
      { role: "user", content: "stopped", __openclaw: { pendingInputCancelledByUser: true } },
      { role: "user", content: "dismissed", display: false },
      { role: "user", content: "retryable" },
      { role: "user", content: "not a boolean", __openclaw: { pendingInputCancelledByUser: 1 } },
    ].map((message) => JSON.stringify(message));
    for (const [index, message] of messages.entries()) {
      database
        .prepare(
          `INSERT INTO session_pending_inputs
          (input_id, session_key, session_id, idempotency_key, run_id, request_hash,
           message_json, lifecycle_generation, state, accepted_at)
          VALUES (?, 'agent:main:test', 'test', ?, ?, 'hash', ?, 'old', 'cancelled', 1)`,
        )
        .run(String(index), String(index), String(index), message);
    }
    const witness = captureOpenClawMigrationWitness(database, {
      role: "agent",
      agentId: "main",
    });
    expect(() =>
      runSqliteImmediateTransactionSync(database, () => {
        migrateAgentPendingInputEndingsInTransaction(database);
        throw new Error("rollback migration");
      }),
    ).toThrow("rollback migration");
    expect(tableHasColumn(database, "session_pending_inputs", "end_cause")).toBe(false);
    expect(tableHasColumn(database, "session_pending_inputs", "origin_source_json")).toBe(false);
    expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 42 });
    expectRow(database, "SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'", {
      schema_version: 42,
    });
    expect(
      database.prepare("SELECT message_json FROM session_pending_inputs ORDER BY seq").all(),
    ).toEqual(messages.map((message_json) => ({ message_json })));
    database.close();
    await migratePreviousDatabase(options, filename);
    const admitted = openOpenClawAgentDatabase(options).db;
    expect(admitted.prepare("PRAGMA user_version").get()).toEqual({
      user_version: OPENCLAW_AGENT_SCHEMA_VERSION,
    });
    expectRow(admitted, "SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'", {
      schema_version: OPENCLAW_AGENT_SCHEMA_VERSION,
    });
    expect(
      admitted
        .prepare(
          "SELECT message_json, end_cause, origin_source_json FROM session_pending_inputs ORDER BY seq",
        )
        .all(),
    ).toEqual(
      messages.map((message_json, index) => ({
        message_json,
        end_cause: index < 2 ? "user-stop" : null,
        origin_source_json: null,
      })),
    );
    expect(
      assertOpenClawMigrationWitnessPreserved(
        witness,
        captureOpenClawMigrationWitness(requireNativeSqliteDatabase(admitted), {
          role: "agent",
          agentId: "main",
        }),
      ),
    ).toEqual({ warnings: ["Preexisting session history gap: emptyWindows (1)"] });
    admitSqliteSchema(requireNativeSqliteDatabase(admitted));
    const exec = vi.spyOn(admitted, "exec");
    try {
      ensureSessionPendingInputsSchema(admitted);
      expect(exec).not.toHaveBeenCalled();
    } finally {
      exec.mockRestore();
    }
  });

  it("admits a version 42 store without creating its absent optional pending-input table", async () => {
    const options = fixture();
    const filename = openOpenClawAgentDatabase(options).path;
    {
      using old = await previousDatabase(filename);
      old.exec(`
        ALTER TABLE session_members DROP COLUMN access;
        DROP TABLE session_pending_inputs;
        ALTER TABLE session_nodes DROP COLUMN archive_undo_marker;
        PRAGMA user_version = 42;
        UPDATE schema_meta SET schema_version = 42 WHERE meta_key = 'primary';
      `);
    }
    await migratePreviousDatabase(options, filename);
    const admitted = openOpenClawAgentDatabase(options).db;
    expect(admitted.prepare("PRAGMA user_version").get()).toEqual({
      user_version: OPENCLAW_AGENT_SCHEMA_VERSION,
    });
    expectRow(admitted, "SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'", {
      schema_version: OPENCLAW_AGENT_SCHEMA_VERSION,
    });
    expect(tableExists(admitted, "session_pending_inputs")).toBe(false);
  });

  it("migrates a version 43 store without checking undeclared relations", async () => {
    const options = fixture();
    const filename = openOpenClawAgentDatabase(options).path;
    {
      using old = await previousDatabase(filename);
      old.exec(`
        ALTER TABLE session_members DROP COLUMN access;
        ALTER TABLE session_nodes DROP COLUMN archive_undo_marker;
        PRAGMA user_version = 43;
        UPDATE schema_meta SET schema_version = 43 WHERE meta_key = 'primary';
        PRAGMA foreign_keys = OFF;
        INSERT INTO board_tabs (session_key, tab_id, title, position, created_by, revision)
        VALUES ('agent:main:missing', 'tab', 'Orphan', 0, 'user', 0);
      `);
    }
    const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
    try {
      await migratePreviousDatabase(options, filename);
      // The step owns only its declared tables; the next start's whole-file check finds the orphan.
      expect(prepare.mock.calls.map(([sql]) => sql)).not.toContainEqual(
        expect.stringMatching(/^PRAGMA (?:quick_check|foreign_key_check);?$/u),
      );
    } finally {
      prepare.mockRestore();
    }
    const admitted = openOpenClawAgentDatabase(options).db;
    expect(admitted.prepare("PRAGMA user_version").get()).toEqual({
      user_version: OPENCLAW_AGENT_SCHEMA_VERSION,
    });
  });

  beforeEach(() => {
    setRuntimeConfigSnapshot({});
  });

  afterEach(() => {
    clearRuntimeConfigSnapshot();
  });

  it("leaves old stores table-free on reads and preserves accepted input through older-reader use and reopen", async () => {
    const options = fixture();
    const scope = {
      ...options,
      sessionKey: "agent:main:pending-schema",
      sessionId: "pending-schema-session",
    };
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    const filename = openOpenClawAgentDatabase(options).path;
    const previous = await previousDatabase(filename);
    previous.exec("DROP TABLE session_pending_inputs");
    const version = previous.prepare("PRAGMA user_version").get();
    const metadata = readRow(previous, metadataSql);
    previous.close();
    expect(await listSessionPendingInputs(scope)).toEqual({ items: [], total: 0 });
    const candidate = openOpenClawAgentDatabase(options);
    expectRow(
      candidate.db,
      "SELECT 1 FROM sqlite_schema WHERE name = 'session_pending_inputs'",
      undefined,
    );
    await stage(scope, "schema-run", "Retain this accepted input");
    ensureSessionPendingInputsSchema(candidate.db);
    const acceptedSql = "SELECT state, message_json FROM session_pending_inputs";
    const accepted = readRow(candidate.db, acceptedSql);
    await closeAgents();
    const older = new DatabaseSync(filename);
    const previousSql = OPENCLAW_AGENT_SCHEMA_SQL.slice(
      0,
      OPENCLAW_AGENT_SCHEMA_SQL.indexOf("CREATE TABLE IF NOT EXISTS session_pending_inputs ("),
    );
    assertSqliteSchemaContains(older, filename, previousSql);
    older
      .prepare("UPDATE schema_meta SET updated_at = updated_at WHERE meta_key = 'primary'")
      .run();
    expect(older.prepare("PRAGMA user_version").get()).toEqual(version);
    expectRow(older, metadataSql, metadata);
    older.close();
    expect(await listSessionPendingInputs(scope)).toEqual({ total: 0, items: [] });
    expectRow(openOpenClawAgentDatabase(options).db, acceptedSql, accepted);
    expectRow(openOpenClawAgentDatabase(options).db, "PRAGMA user_version", version);
  });

  it("rejects a drifted optional table rather than treating it as absent", async () => {
    const options = fixture();
    const filename = openOpenClawAgentDatabase(options).path;
    await closeAgents();
    const drifted = new DatabaseSync(filename);
    drifted.exec(
      "DROP TABLE session_pending_inputs; CREATE TABLE session_pending_inputs (input_id TEXT NOT NULL PRIMARY KEY) STRICT",
    );
    drifted.close();
    expect(() => openOpenClawAgentDatabase(options)).toThrow(/session_pending_inputs|schema/u);
  });

  it.each(["open", "doctor", "first-use"] as const)(
    "adds consumption to an existing same-version store through %s without changing accepted bytes or version markers",
    async (path) => {
      const options = fixture();
      const scope = {
        ...options,
        sessionKey: "agent:main:column",
        sessionId: "column-session",
      };
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      await stage(scope, "column-run", "Retain exact input");
      const filename = openOpenClawAgentDatabase(options).path;
      const old = await previousDatabase(filename);
      old.exec("ALTER TABLE session_pending_inputs DROP COLUMN consumed_event_id");
      const version = old.prepare("PRAGMA user_version").get();
      const metadata = readRows(old, "SELECT * FROM schema_meta");
      const messageSql = "SELECT message_json FROM session_pending_inputs";
      const original = readRow(old, messageSql);
      old.close();
      await expect(listSessionPendingInputs(scope)).rejects.toThrow(
        "requires writable startup admission before session reads",
      );
      if (path === "open") {
        openOpenClawAgentDatabase(options);
        await closeAgents();
      } else {
        const current = openNodeSqliteDatabase(filename);
        if (path === "doctor") {
          ensureOpenClawAgentDatabaseSchema(current, options);
        } else {
          ensureSessionPendingInputsSchema(current);
        }
        current.close();
      }
      expect(await listSessionPendingInputs(scope)).toEqual({ total: 0, items: [] });
      using reopened = new DatabaseSync(filename, { readOnly: true });
      expectRow(reopened, "PRAGMA user_version", version);
      expectRows(reopened, "SELECT * FROM schema_meta", metadata);
      expectRow(reopened, messageSql, original);
      expectRow(reopened, "SELECT consumed_event_id FROM session_pending_inputs", {
        consumed_event_id: null,
      });
    },
  );

  it.each([
    { connection: "legacy", existing: false },
    { connection: "legacy", existing: true },
    { connection: "admitted", existing: false },
    { connection: "admitted", existing: true },
  ])(
    "retries first-use DDL after rollback on the same $connection connection (existing table: $existing)",
    ({ connection, existing }) => {
      const database =
        connection === "admitted"
          ? openNodeSqliteDatabase(":memory:")
          : new DatabaseSync(":memory:");
      try {
        database.exec(
          OPENCLAW_AGENT_SCHEMA_SQL.replace(canonicalSessionValidationSchemaSql(), "").replace(
            "  consumed_event_id TEXT,\n",
            "",
          ),
        );
        database.exec("PRAGMA user_version = 19");
        if (!existing) {
          database.exec("DROP TABLE session_pending_inputs");
        }
        if (connection === "admitted") {
          admitSqliteSchema(database);
        }
        const before = database.prepare("PRAGMA schema_version").get();
        expect(() =>
          runSqliteImmediateTransactionSync(database, () => {
            if (connection === "admitted") {
              expect(hasSessionPendingInputsSchema(database)).toBe(existing);
            }
            ensureSessionPendingInputsSchema(database);
            if (connection === "admitted") {
              expect(hasSessionPendingInputsSchema(database)).toBe(true);
            }
            throw new Error("abort first use");
          }),
        ).toThrow("abort first use");
        expect(database.prepare("PRAGMA schema_version").get()).toEqual(before);
        expect(tableExists(database, "session_pending_inputs")).toBe(existing);
        expect(tableHasColumn(database, "session_pending_inputs", "consumed_event_id")).toBe(false);
        if (connection === "admitted") {
          expect(hasSessionPendingInputsSchema(database)).toBe(existing);
        }
        ensureSessionPendingInputsSchema(database);
        expect(tableHasColumn(database, "session_pending_inputs", "consumed_event_id")).toBe(true);
        const after = database.prepare("PRAGMA schema_version").get();
        ensureSessionPendingInputsSchema(database);
        expect(database.prepare("PRAGMA schema_version").get()).toEqual(after);
        expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 19 });
      } finally {
        database.close();
      }
    },
  );

  it.each([
    { marker: { __openclaw: { pendingInputCancelledByUser: true } }, retired: true },
    { marker: { display: false }, retired: true },
    { marker: {}, retired: false },
  ])("migrates retirement before reclamation: %j", async ({ marker, retired }) => {
    const options = fixture();
    const scope = {
      ...options,
      sessionKey: "agent:main:legacy-retired",
      sessionId: "legacy-retired-session",
    };
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    const sourceTurn = {
      role: "user" as const,
      content: "legacy retired input",
      timestamp: 100,
      idempotencyKey: "channel-user:v1:legacy-retired",
    };
    const stageInput = (
      runId: string,
      overrides: Partial<Parameters<typeof stageSessionPendingInput>[1]> = {},
    ) =>
      stageSessionPendingInput(scope, {
        runId,
        message: sourceTurn,
        assertCurrent() {},
        ...overrides,
      });
    const first = (await stageInput("legacy-attempt-1"))!;
    first.finish("cancelled", "failed");
    await first.settled?.();
    const filename = openOpenClawAgentDatabase(options).path;
    const legacyMessage = JSON.stringify({ ...sourceTurn, ...marker });
    {
      using old = await previousDatabase(filename);
      old.exec(`
        ALTER TABLE session_members DROP COLUMN access;
        ALTER TABLE session_pending_inputs DROP COLUMN end_cause;
        ALTER TABLE session_pending_inputs DROP COLUMN origin_source_json;
        ALTER TABLE session_nodes DROP COLUMN archive_undo_marker;
        PRAGMA user_version = 42;
        UPDATE schema_meta SET schema_version = 42 WHERE meta_key = 'primary';
      `);
      old
        .prepare("UPDATE session_pending_inputs SET message_json = ? WHERE input_id = ?")
        .run(legacyMessage, first.inputId);
    }
    await migratePreviousDatabase(options, filename);
    await runSessionStartupMigration({
      cfg: { session: { store: filename } },
      env: options.env,
      agentIds: new Set(["main"]),
      log: { info: vi.fn(), warn: vi.fn() },
    });
    expect(await readSessionPendingInput(scope, first.inputId)).toMatchObject({
      state: "cancelled",
      ...(retired ? { endCause: "user-stop" } : {}),
    });
    if (retired) {
      await expect(
        stageInput("legacy-attempt-2", { reclaimCancelledSourceTurn: true }),
      ).rejects.toThrow("idempotency key conflicts");
      await expect(stageInput("legacy-attempt-1", { retryCancelled: true })).rejects.toThrow(
        "ownership ended",
      );
    } else {
      const renewed = (await stageInput("legacy-attempt-2", {
        reclaimCancelledSourceTurn: true,
      }))!;
      try {
        expect(renewed.inputId).toBe(first.inputId);
        expect(await readSessionPendingInput(scope, first.inputId)).toMatchObject({
          state: "queued",
        });
      } finally {
        renewed.finish("interrupted", "failed");
        await renewed.settled?.();
      }
    }
    expect(
      openOpenClawAgentDatabase(options)
        .db.prepare("SELECT message_json FROM session_pending_inputs WHERE input_id = ?")
        .get(first.inputId),
    ).toEqual({ message_json: legacyMessage });
  });
});
