import { expect } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { runOpenClawAgentWriteTransaction } from "../../state/openclaw-agent-db.js";
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import { recordLegacyAcpMigrationSources } from "./session-accessor.sqlite-acp-provenance.js";
import { clearSqliteSessionEntryPreservingWindows } from "./session-accessor.sqlite-entry-clear.js";
import {
  readExactSessionEntryRow,
  writeSessionEntry,
} from "./session-accessor.sqlite-entry-store.js";
import { test } from "./session-entry-fixture.test-support.js";

test("commits and clears ACP provenance atomically without extra queries", ({ store }) => {
  const { database, options, sessionKey } = store;
  const original = { sessionId: "original", lifecycleRevision: "original", updatedAt: 1 };
  const next = { sessionId: "next", lifecycleRevision: "next", updatedAt: 2 };
  const source = (entry: typeof original, hash: string) => ({
    sourcePath: "/legacy/acp.json",
    sourceSessionKey: sessionKey,
    sessionId: entry.sessionId,
    lifecycleRevision: entry.lifecycleRevision,
    sourceSha256: hash.repeat(64),
    sourceSizeBytes: 1,
  });
  const migrations = [source(original, "a"), source(next, "b")];
  runOpenClawAgentWriteTransaction((owner) => {
    writeSessionEntry(owner, sessionKey, original);
    recordLegacyAcpMigrationSources(owner.db, sessionKey, migrations);
  }, options);
  const sources = () =>
    database.db
      .prepare("SELECT legacy_acp_migration_json FROM session_nodes WHERE session_key = ?")
      .get(sessionKey)?.legacy_acp_migration_json;
  const expectRetained = () => {
    expect(JSON.parse(String(sources()))).toEqual([
      expect.objectContaining({ lifecycleRevision: "next", sourceSha256: "b".repeat(64) }),
    ]);
    expect(readExactSessionEntryRow(database, sessionKey)?.entry).toMatchObject(next);
  };
  const writeNext = (owner: typeof database, entry = next) => {
    const { entry: canonicalPreviousEntry, row: canonicalPreviousRow } = readExactSessionEntryRow(
      owner,
      sessionKey,
    )!;
    writeSessionEntry(owner, sessionKey, entry, { canonicalPreviousEntry, canonicalPreviousRow });
  };
  const withoutProvenanceQueries = (change: (owner: typeof database) => void) =>
    runOpenClawAgentWriteTransaction((owner) => {
      const queries = trackSqliteStatementExecutions(
        requireNativeSqliteDatabase(owner.db),
        ["provenanceReads", "provenanceUpdates"],
        (sql) =>
          /^select "legacy_acp_migration_json"/i.test(sql)
            ? "provenanceReads"
            : /^update "session_nodes" set "legacy_acp_migration_json"/i.test(sql)
              ? "provenanceUpdates"
              : null,
      );
      try {
        change(owner);
        expect(queries.counts).toEqual({ provenanceReads: 0, provenanceUpdates: 0 });
      } finally {
        queries.restore();
      }
    }, options);
  withoutProvenanceQueries(writeNext);
  expectRetained();

  expect(() =>
    runOpenClawAgentWriteTransaction((owner) => {
      writeNext(owner, { ...next, lifecycleRevision: "rolled-back" });
      throw new Error("rollback lifecycle");
    }, options),
  ).toThrow("rollback lifecycle");
  expectRetained();

  withoutProvenanceQueries((owner) => {
    clearSqliteSessionEntryPreservingWindows(owner, {
      sessionKey,
      sessionId: next.sessionId,
      updatedAt: 3,
    });
  });
  expect(sources()).toBeNull();
  expect(readExactSessionEntryRow(database, sessionKey)).toBeUndefined();
  expect(
    database.db
      .prepare("SELECT session_id FROM session_windows WHERE session_id = ?")
      .get(next.sessionId),
  ).toMatchObject({ session_id: next.sessionId });
});
