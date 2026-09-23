import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { upsertSessionEntryCore } from "./session-accessor.js";
import { readSessionEntryCount } from "./session-accessor.sqlite-entry-inventory.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

it("counts mixed validated and raw entries with the same archive filter", async () => {
  const scope = {
    agentId: "main",
    env: { ...process.env, OPENCLAW_STATE_DIR: tempDirs.make("openclaw-entry-count-") },
  };
  const database = openOpenClawAgentDatabase(scope);
  expect(readSessionEntryCount(database)).toBe(0);
  expect(readSessionEntryCount(database, { includeArchived: false })).toBe(0);
  for (const archived of [false, true]) {
    await upsertSessionEntryCore(
      { ...scope, sessionKey: "agent:main:validated-" + archived },
      { sessionId: "validated-" + archived, updatedAt: 1, archivedAt: archived ? 1 : undefined },
    );
    database.db
      .prepare(
        "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at, archived_at) VALUES (?, ?, ?, 1, ?)",
      )
      .run(
        "agent:main:raw-" + archived,
        "raw-" + archived,
        JSON.stringify({ sessionId: "raw-" + archived, updatedAt: 1 }),
        archived ? 1 : null,
      );
  }
  database.db
    .prepare(
      "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at) VALUES (?, ?, ?, 1)",
    )
    .run("agent:main:invalid", "invalid", "{");
  expect(readSessionEntryCount(database)).toBe(4);
  expect(readSessionEntryCount(database, { includeArchived: false })).toBe(2);
  database.db
    .prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?")
    .run("{}", "agent:main:validated-false");
  expect(readSessionEntryCount(database)).toBe(3);
  expect(readSessionEntryCount(database, { includeArchived: false })).toBe(1);

  const writer = new DatabaseSync(database.path);
  try {
    writer
      .prepare("UPDATE session_nodes SET archived_at = 1 WHERE session_key = ?")
      .run("agent:main:raw-false");
    expect(readSessionEntryCount(database)).toBe(3);
    expect(readSessionEntryCount(database, { includeArchived: false })).toBe(0);
    writer.prepare("DELETE FROM session_nodes WHERE session_key = ?").run("agent:main:raw-true");
    expect(readSessionEntryCount(database)).toBe(2);
    expect(readSessionEntryCount(database, { includeArchived: false })).toBe(0);
  } finally {
    writer.close();
  }

  expect(() =>
    runOpenClawAgentWriteTransaction((owner) => {
      owner.db.exec("DELETE FROM session_nodes");
      expect(readSessionEntryCount(owner)).toBe(0);
      expect(readSessionEntryCount(owner, { includeArchived: false })).toBe(0);
      throw new Error("roll back count changes");
    }, scope),
  ).toThrow("roll back count changes");
  expect(readSessionEntryCount(database)).toBe(2);
  expect(readSessionEntryCount(database, { includeArchived: false })).toBe(0);
});
