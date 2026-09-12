import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import {
  readAgentRunTerminalReceipt,
  writeAgentRunTerminalReceipt,
} from "./agent-run-terminal-receipts.js";
import { ensureAgentRunTerminalReceiptSchema } from "./openclaw-state-db-schema-additive.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";
import { removePreparedWorkerOwnershipColumns } from "./openclaw-state-schema-v17.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const owner = { agentId: "agent-a", sessionKey: "agent:a:main", sessionId: "session-a" };
const terminalJson = JSON.stringify({ status: "ok", startedAt: 10, endedAt: 20 });

function testOptions(label: string) {
  return { env: { ...process.env, OPENCLAW_STATE_DIR: tempDirs.make(label) } };
}

function readVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  return row.user_version;
}

function hasReceiptTable(db: DatabaseSync): boolean {
  return Boolean(
    db
      .prepare(
        "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'agent_run_terminal_receipts'",
      )
      .get(),
  );
}

describe("same-version additive terminal receipt schema", () => {
  it("keeps an existing v17 database at v17 and installs receipts only on first write", () => {
    const options = testOptions("openclaw-terminal-receipts-additive-");
    const initial = openOpenClawStateDatabase(options);
    const databasePath = initial.path;

    expect(OPENCLAW_STATE_SCHEMA_VERSION).toBe(17);
    expect(readVersion(initial.db)).toBe(17);
    expect(hasReceiptTable(initial.db)).toBe(false);

    closeOpenClawStateDatabaseForTest();
    const existing = openOpenClawStateDatabase(options);
    expect(readVersion(existing.db)).toBe(17);
    expect(hasReceiptTable(existing.db)).toBe(false);

    const runId = `opaque-${"x".repeat(300)}`;
    expect(writeAgentRunTerminalReceipt({ runId, owner, terminalJson, env: options.env })).toBe(
      true,
    );
    expect(readVersion(existing.db)).toBe(17);
    expect(hasReceiptTable(existing.db)).toBe(true);

    closeOpenClawStateDatabaseForTest();
    const reopened = openOpenClawStateDatabase(options);
    expect(readVersion(reopened.db)).toBe(17);
    expect(readAgentRunTerminalReceipt({ runId, owner, now: 11, env: options.env })).toMatchObject({
      runId,
    });

    closeOpenClawStateDatabaseForTest();
    const oldReader = openNodeSqliteDatabase(databasePath, { readOnly: true });
    try {
      expect(readVersion(oldReader)).toBe(17);
      expect(
        oldReader.prepare("SELECT role FROM schema_meta WHERE meta_key = 'primary'").get(),
      ).toEqual({ role: "global" });
    } finally {
      oldReader.close();
    }
  });

  it("keeps a published-v16 database at v16 after adding the receipt table", () => {
    const options = testOptions("openclaw-terminal-receipts-published-v16-");
    const initial = openOpenClawStateDatabase(options);
    const databasePath = initial.path;
    closeOpenClawStateDatabaseForTest();

    const publishedDatabase = openNodeSqliteDatabase(databasePath);
    try {
      removePreparedWorkerOwnershipColumns(publishedDatabase);
      publishedDatabase.exec(`
        PRAGMA user_version = 16;
        UPDATE schema_meta SET schema_version = 16 WHERE meta_key = 'primary';
      `);
      ensureAgentRunTerminalReceiptSchema(publishedDatabase);
      const runId = `opaque-${"x".repeat(300)}`;
      publishedDatabase
        .prepare(
          `INSERT INTO agent_run_terminal_receipts (
             run_id, agent_id, session_key, session_id, terminal_json, created_at_ms, expires_at_ms
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(runId, owner.agentId, owner.sessionKey, owner.sessionId, terminalJson, 10, 20);

      expect(readVersion(publishedDatabase)).toBe(16);
      expect(
        publishedDatabase
          .prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'")
          .get(),
      ).toEqual({ schema_version: 16 });
      expect(
        publishedDatabase
          .prepare("SELECT run_id FROM agent_run_terminal_receipts WHERE run_id = ?")
          .get(runId),
      ).toEqual({ run_id: runId });
    } finally {
      publishedDatabase.close();
    }

    const publishedReader = openNodeSqliteDatabase(databasePath, { readOnly: true });
    try {
      expect(readVersion(publishedReader)).toBe(16);
      expect(hasReceiptTable(publishedReader)).toBe(true);
    } finally {
      publishedReader.close();
    }
  });
});
