import { channel } from "node:diagnostics_channel";
import { expect, test } from "vitest";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { readSessionStateDeleteSnapshot } from "./session-accessor.sqlite-delete-snapshot.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { loadSessionEntry } from "./session-accessor.sqlite-entry.js";
import { drainSessionStateTranscriptIndexes } from "./session-accessor.sqlite-lifecycle-state.js";
import { deleteSessionEntryLifecycle } from "./session-accessor.sqlite-lifecycle.js";
import { SESSION_TRANSCRIPT_INDEX_DRAIN_BUDGET } from "./session-accessor.sqlite-reclamation.js";
import {
  resolveSqliteTranscriptScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { appendTranscriptMessageInTransaction } from "./session-accessor.sqlite-transcript-message-append.js";
import { reconcileSessionTranscriptIndexInTransaction } from "./session-transcript-index.js";

const EVENTS = 300;

function seed(env: NodeJS.ProcessEnv, sessionId: string, events = EVENTS) {
  const resolved = resolveSqliteTranscriptScope({
    agentId: "main",
    env,
    sessionId,
    sessionKey: `agent:main:${sessionId}`,
  });
  runOpenClawAgentWriteTransaction((database) => {
    writeSessionEntry(database, resolved.sessionKey, { sessionId, updatedAt: 1 });
    for (let index = 0; index < events; index += 1) {
      appendTranscriptMessageInTransaction(database, resolved, {
        message: { role: index % 2 ? "assistant" : "user", content: `synthetic words ${index}` },
      });
    }
  }, toDatabaseOptions(resolved));
  return resolved;
}

function counts(database: OpenClawAgentDatabase, sessionId: string) {
  const count = (table: string) =>
    (
      database.db
        .prepare(`SELECT count(*) AS n FROM ${table} WHERE session_id = ?`)
        .get(sessionId) as { n: number }
    ).n;
  const state = database.db
    .prepare("SELECT needs_rebuild FROM session_transcript_index_state WHERE session_id = ?")
    .get(sessionId) as { needs_rebuild: number } | undefined;
  return {
    events: count("transcript_events"),
    fts: count("session_transcript_fts_rows"),
    active: count("session_transcript_active_events"),
    needsRebuild: state?.needs_rebuild,
  };
}

test("a partial drain keeps canonical rows, hides the projection, and reconcile restores it", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const resolved = seed(state.env, "drain-refused");
    const options = toDatabaseOptions(resolved);
    const database = openOpenClawAgentDatabase(options);
    const before = counts(database, resolved.sessionId);
    expect(before).toMatchObject({ events: EVENTS + 1, needsRebuild: 0 });
    const targets = [
      {
        sessionId: resolved.sessionId,
        snapshot: readSessionStateDeleteSnapshot(database.db, resolved.sessionId),
      },
    ];
    const excluded = new Set([resolved.sessionKey]);
    const budget = { maxRows: 64, maxBytes: SESSION_TRANSCRIPT_INDEX_DRAIN_BUDGET.maxBytes };
    // A still-referenced window survives deletion, so it is never drained.
    expect(
      runOpenClawAgentWriteTransaction(
        (owner) => drainSessionStateTranscriptIndexes(owner, targets, new Set(), budget),
        options,
      ),
    ).toEqual({ deletedRows: 0, complete: true });
    expect(counts(database, resolved.sessionId)).toEqual(before);

    const batch = runOpenClawAgentWriteTransaction(
      (owner) => drainSessionStateTranscriptIndexes(owner, targets, excluded, budget),
      options,
    );
    expect(batch).toEqual({ deletedRows: 64, complete: false });
    // The deletion is now refused: canonical rows are intact and readers see a dirty projection.
    const refused = counts(database, resolved.sessionId);
    expect(refused).toMatchObject({ events: before.events, needsRebuild: 1 });
    expect(refused.fts + refused.active).toBe(before.fts + before.active - 64);
    expect(readSessionStateDeleteSnapshot(database.db, resolved.sessionId)).toEqual(
      targets[0]?.snapshot,
    );
    runOpenClawAgentWriteTransaction(
      (owner) =>
        expect(reconcileSessionTranscriptIndexInTransaction(owner.db, resolved.sessionId)).toBe(
          true,
        ),
      options,
    );
    expect(counts(database, resolved.sessionId)).toEqual(before);

    // Newer canonical state means the deletion will refuse; draining stops without dirtying.
    runOpenClawAgentWriteTransaction((owner) => {
      appendTranscriptMessageInTransaction(owner, resolved, {
        message: { role: "user", content: "synthetic late append" },
      });
    }, options);
    const appended = counts(database, resolved.sessionId);
    expect(
      runOpenClawAgentWriteTransaction(
        (owner) => drainSessionStateTranscriptIndexes(owner, targets, excluded, budget),
        options,
      ),
    ).toEqual({ deletedRows: 0, complete: true });
    expect(counts(database, resolved.sessionId)).toEqual(appended);
  });
});

test("entry deletion drains its derived index in bounded worker grants before archiving", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const resolved = seed(state.env, "drain-deleted");
    const storePath = openOpenClawAgentDatabase({ agentId: "main", env: state.env }).path;
    const grants: Array<{ operation: string; nativeTransactionMs?: number }> = [];
    const diagnostics = channel("openclaw.session.write");
    const collect = (event: unknown) => {
      const write = event as { writer: string; operation: string; admissionPhasesMs?: unknown };
      if (write.writer === "worker" && write.admissionPhasesMs) {
        grants.push(write);
      }
    };
    diagnostics.subscribe(collect);
    try {
      const result = await deleteSessionEntryLifecycle({
        agentId: "main",
        env: state.env,
        storePath,
        archiveTranscript: true,
        target: { canonicalKey: resolved.sessionKey, storeKeys: [resolved.sessionKey] },
      });
      expect(result.deleted).toBe(true);
      expect(result.archivedTranscripts).toHaveLength(1);
    } finally {
      diagnostics.unsubscribe(collect);
    }
    expect(loadSessionEntry(resolved)).toBeUndefined();
    const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
    expect(counts(database, resolved.sessionId)).toMatchObject({ events: 0, fts: 0, active: 0 });
    // 300 messages project ~600 derived rows: at least three 256-row drain grants, then the deletion.
    expect(grants.length).toBeGreaterThanOrEqual(4);
  });
});
