import { expect, it } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { recordLegacyAcpMigrationSources } from "./session-accessor.sqlite-acp-provenance.js";
import { clearSqliteSessionEntryPreservingWindows } from "./session-accessor.sqlite-entry-clear.js";
import {
  readExactSessionEntryRow,
  writeSessionEntry,
} from "./session-accessor.sqlite-entry-store.js";

it("commits retained ACP sources with the entry lifecycle and clears them without a separate read or write", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const options = { agentId: "main", env: state.env };
    const database = openOpenClawAgentDatabase(options);
    const sessionKey = "agent:main:provenance";
    const original = { sessionId: "original", lifecycleRevision: "original", updatedAt: 1 };
    const next = { sessionId: "next", lifecycleRevision: "next", updatedAt: 2 };
    const source = {
      sourcePath: "/legacy/acp.json",
      sourceSessionKey: sessionKey,
      sessionId: original.sessionId,
      lifecycleRevision: original.lifecycleRevision,
      sourceSha256: "a".repeat(64),
      sourceSizeBytes: 1,
    };
    const retained = {
      ...source,
      sessionId: next.sessionId,
      lifecycleRevision: next.lifecycleRevision,
      sourceSha256: "b".repeat(64),
    };
    runOpenClawAgentWriteTransaction((owner) => {
      writeSessionEntry(owner, sessionKey, original);
      recordLegacyAcpMigrationSources(owner.db, sessionKey, [source, retained]);
    }, options);
    const sources = () =>
      database.db
        .prepare("SELECT legacy_acp_migration_json FROM session_nodes WHERE session_key = ?")
        .get(sessionKey)?.legacy_acp_migration_json;

    runOpenClawAgentWriteTransaction((owner) => {
      const previous = readExactSessionEntryRow(owner, sessionKey)!;
      const queries = trackSqliteStatementExecutions(
        owner.db,
        ["provenanceReads", "provenanceUpdates"],
        (sql) =>
          /^select "legacy_acp_migration_json"/i.test(sql)
            ? "provenanceReads"
            : /^update "session_nodes" set "legacy_acp_migration_json"/i.test(sql)
              ? "provenanceUpdates"
              : null,
      );
      try {
        writeSessionEntry(owner, sessionKey, next, {
          canonicalPreviousEntry: previous.entry,
          canonicalPreviousRow: previous.row,
        });
        expect(queries.counts).toEqual({ provenanceReads: 0, provenanceUpdates: 0 });
      } finally {
        queries.restore();
      }
    }, options);
    expect(JSON.parse(String(sources()))).toEqual([
      expect.objectContaining({ lifecycleRevision: "next", sourceSha256: "b".repeat(64) }),
    ]);
    expect(readExactSessionEntryRow(database, sessionKey)?.entry).toMatchObject(next);

    expect(() =>
      runOpenClawAgentWriteTransaction((owner) => {
        const previous = readExactSessionEntryRow(owner, sessionKey)!;
        writeSessionEntry(
          owner,
          sessionKey,
          { ...next, lifecycleRevision: "rolled-back" },
          {
            canonicalPreviousEntry: previous.entry,
            canonicalPreviousRow: previous.row,
          },
        );
        throw new Error("rollback lifecycle");
      }, options),
    ).toThrow("rollback lifecycle");
    expect(JSON.parse(String(sources()))).toEqual([
      expect.objectContaining({ lifecycleRevision: "next", sourceSha256: "b".repeat(64) }),
    ]);
    expect(readExactSessionEntryRow(database, sessionKey)?.entry).toMatchObject(next);

    runOpenClawAgentWriteTransaction((owner) => {
      const queries = trackSqliteStatementExecutions(
        owner.db,
        ["provenanceReads", "provenanceUpdates"],
        (sql) =>
          /^select "legacy_acp_migration_json"/i.test(sql)
            ? "provenanceReads"
            : /^update "session_nodes" set "legacy_acp_migration_json"/i.test(sql)
              ? "provenanceUpdates"
              : null,
      );
      try {
        clearSqliteSessionEntryPreservingWindows(owner, {
          sessionKey,
          sessionId: next.sessionId,
          updatedAt: 3,
        });
        expect(queries.counts).toEqual({ provenanceReads: 0, provenanceUpdates: 0 });
      } finally {
        queries.restore();
      }
    }, options);
    expect(sources()).toBeNull();
    expect(readExactSessionEntryRow(database, sessionKey)).toBeUndefined();
    expect(
      database.db
        .prepare("SELECT session_id FROM session_windows WHERE session_id = ?")
        .get(next.sessionId),
    ).toMatchObject({ session_id: next.sessionId });
  });
});
