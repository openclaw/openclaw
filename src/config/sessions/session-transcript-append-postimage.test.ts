import assert from "node:assert/strict";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { observeSqliteReadSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { getSqliteReadScopeRevision } from "../../infra/sqlite-schema-facts.js";
import { runOpenClawAgentWriteTransaction as writeTransaction } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import { prepareSessionEntryReplacementPublication } from "./session-accessor.sqlite-replacement-state.js";
import { resolveSqliteTranscriptScope } from "./session-accessor.sqlite-scope.js";
import { appendTranscriptMessageInTransaction as appendMessage } from "./session-accessor.sqlite-transcript-message-append.js";
import {
  readCommittedTranscriptMessageSequence as readSequence,
  rememberCommittedTranscriptMessageSequences as rememberSequences,
  rememberCommittedTranscriptMessageSequencesInTransaction as rememberCursor,
} from "./session-accessor.sqlite-transcript-sequences.js";
import { readTranscriptContextVersionInTransaction as readVersion } from "./session-accessor.sqlite-transcript-state.js";
import { runTranscriptWriteSnapshotSync as writeSnapshot } from "./session-accessor.sqlite-transcript-write-snapshot.js";
import { appendTranscriptMessageSnapshotSync as appendSnapshot } from "./session-accessor.sqlite-transcript-write.js";
import { createSessionCompoundWorkerFixture } from "./session-compound-worker.test-support.js";
import { readSessionPendingInputAuthorityFacts as readAuthorityFacts } from "./session-pending-input-authority.kernel.js";
import { readTranscriptAppendPostimage as readPostimage } from "./session-transcript-append-postimage.js";

let f: ReturnType<typeof createSessionCompoundWorkerFixture>;
it.aroundEach(async (runTest) =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    f = createSessionCompoundWorkerFixture();
    await runTest().finally(() => vi.restoreAllMocks());
  }),
);

const event = (eventId: string, parentId?: null) => ({
  eventId,
  ...(parentId === null ? { parentId } : {}),
  message: { role: "assistant" as const, content: eventId },
});

const observeReads = () => observeSqliteReadSql(StatementSync.prototype);

it.each([false, true])(
  "publishes the final append version after a later mutation: %s",
  (mutate) => {
    const reads = observeReads();
    let checks = 0;
    const result = appendSnapshot(f.scope, event("message"), undefined, undefined, {
      assertCurrent() {
        if (++checks === 2 && mutate) {
          const sql = "UPDATE session_windows SET transcript_updated_at = 42 WHERE session_id = ?";
          f.database.db.prepare(sql).run(f.scope.sessionId);
        }
      },
      onPendingTransaction() {},
    });
    reads.restore();
    assert(result.ok, "Append refused");
    expect(result.value.after).toEqual(readVersion(f.database, f.scope.sessionId));
    expect(result.value.after.rawSeq).toBe(1);
    if (mutate) {
      expect(result.value.after.updatedAt).toBe(42);
    }
    // A fresh append already read its final version with its anchor. A later write expires it.
    expect(reads.queries.filter((sql) => sql.startsWith("select coalesce(")).length).toBe(
      mutate ? 2 : 1,
    );

    {
      using foreign = new DatabaseSync(f.database.path);
      const sql = "UPDATE transcript_rewrite_watermarks SET generation = ? WHERE session_id = ?";
      foreign.prepare(sql).run("foreign-generation", f.scope.sessionId);
    }
    expect(appendSnapshot(f.scope, event("next"))).toMatchObject({
      ok: true,
      value: {
        before: { generation: "foreign-generation", rawSeq: 1 },
        after: { generation: "foreign-generation", rawSeq: 2 },
      },
    });
  },
);

it("shares committed entry facts with custody while retaining live member and row checks", () => {
  writeTransaction((database) => {
    const before = f.read()!;
    const entry = writeSessionEntry(database, f.scope.sessionKey, {
      ...before,
      updatedAt: 2,
      label: "committed",
    });
    const publication = prepareSessionEntryReplacementPublication(
      {
        previous: new Map([[f.scope.sessionKey, before]]),
        current: new Map([[f.scope.sessionKey, entry]]),
        pendingArchiveRecovery: false,
        membershipInvalidatedKeys: [],
        maintenancePlans: [],
      },
      database,
    );
    const postimage = {
      sessionKey: f.scope.sessionKey,
      entry: publication.current.get(f.scope.sessionKey)!,
      revision: getSqliteReadScopeRevision(database.db)!,
    };
    const readFacts = () =>
      readAuthorityFacts(database, f.scope.sessionKey, f.scope.agentId, postimage);
    const exec = vi.spyOn(database.db, "exec");
    const reads = observeReads();
    const facts = readFacts();
    reads.restore();
    expect(facts).toMatchObject({ entry: { label: "committed" }, members: [] });
    expect(reads.queries.filter((sql) => sql.includes('from "session_nodes"'))).toEqual([]);
    expect(exec).not.toHaveBeenCalled();
    if (facts.entry) {
      facts.entry.label = "caller-owned";
    }
    expect(postimage.entry.label).toBe("committed");
    writeSessionEntry(database, f.scope.sessionKey, {
      ...postimage.entry,
      label: "new writer",
      updatedAt: 3,
    });
    const addMember =
      "INSERT INTO session_members (session_key, identity_id, added_by, added_at) VALUES (?, ?, ?, ?)";
    database.db.prepare(addMember).run(f.scope.sessionKey, "new-member", "owner", 1);
    expect(readFacts()).toMatchObject({
      entry: { label: "new writer" },
      members: [{ identityId: "new-member" }],
    });
  }, f.scope);
});

it.each([false, true])(
  "uses the append cursor only while its branch is current: %s",
  (replaceBranch) => {
    const scope = resolveSqliteTranscriptScope(f.scope);
    writeTransaction((db) => {
      const appended = appendMessage(db, scope, event("first"));
      assert(appended, "Missing append");
      if (replaceBranch) {
        appendMessage(db, scope, event("replacement", null));
      }
      const reads = observeReads();
      rememberCursor(db, f.scope.sessionId, [appended.result], readPostimage(appended));
      expect(readSequence(appended.result)).toBe(replaceBranch ? undefined : 1);
      if (!replaceBranch) {
        expect(reads.queries).toEqual([]);
      }
    }, f.scope);
  },
);

it.each([false, true])(
  "publishes only ready final turn cursors through the history worker: branch changed %s",
  async (replaceBranch) => {
    const scope = resolveSqliteTranscriptScope(f.scope);
    const messages = writeTransaction((db) => {
      const first = appendMessage(db, scope, event("first"));
      const second = appendMessage(db, scope, event("second", replaceBranch ? null : undefined));
      assert(first && second, "Missing committed messages");
      return [first.result, second.result];
    }, f.scope);
    const reads = observeReads();
    await rememberSequences(f.scope, messages);
    // An explicit branch change invalidates the projection until its owner rebuilds it.
    expect(messages.map(readSequence)).toEqual(replaceBranch ? [undefined, undefined] : [1, 2]);
    expect(reads.queries).toEqual([]);
  },
);

it("preserves caller callback results without interpreting postimage-shaped fields", () => {
  const value = { value: 7, postimage: "caller data" };
  expect(writeSnapshot(f.scope, () => value)).toMatchObject({ ok: true, value: { result: value } });
});

it("keeps snapshot versions scoped to the requested session when a callback appends elsewhere", () => {
  const other = { ...f.scope, sessionKey: "agent:main:other", sessionId: "other" };
  replaceSessionEntrySync(other, { sessionId: other.sessionId, updatedAt: 1 });
  const result = writeSnapshot(f.scope, (database) =>
    appendMessage(database, resolveSqliteTranscriptScope(other), event("other-message")),
  );
  assert(result.ok, "Snapshot refused");
  expect(result.value.result?.result).toMatchObject({
    appended: true,
    messageId: "other-message",
  });
  expect(readVersion(f.database, other.sessionId).rawSeq).toBe(1);
  expect(result.value.after).toEqual(result.value.before);
  expect(result.value.after).toEqual(readVersion(f.database, f.scope.sessionId));
});

it("reuses the write's context postimage and retires it after a raw write or rollback", () => {
  writeTransaction((database) => {
    appendMessage(database, resolveSqliteTranscriptScope(f.scope), event("saved"));
    const reads = observeReads();
    const saved = readVersion(database, f.scope.sessionId);
    const changedCopy = readVersion(database, f.scope.sessionId);
    reads.restore();
    expect(reads.queries).toEqual([]);
    expect(saved.rawSeq).toBe(1);
    changedCopy.updatedAt = -1;
    expect(readVersion(database, f.scope.sessionId)).toEqual(saved);

    expect(() =>
      writeTransaction((nested) => {
        const sql = "UPDATE session_windows SET transcript_updated_at = ? WHERE session_id = ?";
        nested.db.prepare(sql).run(42, f.scope.sessionId);
        expect(readVersion(nested, f.scope.sessionId).updatedAt).toBe(42);
        throw new Error("rollback nested context");
      }, f.scope),
    ).toThrow("rollback nested context");
    expect(readVersion(database, f.scope.sessionId)).toEqual(saved);
  }, f.scope);
});
