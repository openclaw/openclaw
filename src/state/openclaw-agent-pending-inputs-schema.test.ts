import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import {
  listSessionPendingInputs,
  stageSessionPendingInput,
} from "../config/sessions/session-accessor.pending-inputs.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { assertSqliteSchemaContains } from "../infra/sqlite-schema-contract.test-support.js";
import { admitSqliteSchema } from "../infra/sqlite-schema-facts.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import { canonicalSessionValidationSchemaSql } from "./openclaw-agent-canonical-validation-schema.js";
import { ensureOpenClawAgentDatabaseSchema } from "./openclaw-agent-db-schema.js";
import {
  closeOpenClawAgentDatabasesForTest,
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "./openclaw-agent-db.js";
import {
  ensureSessionPendingInputsSchema,
  hasSessionPendingInputsSchema,
} from "./openclaw-agent-pending-inputs-schema.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";
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
  receipt!.finish("interrupted");
  await receipt!.settled?.();
  return receipt!;
}
const metadataSql = "SELECT schema_version, updated_at FROM schema_meta WHERE meta_key = 'primary'";

describe("pending input additive schema", () => {
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
});
