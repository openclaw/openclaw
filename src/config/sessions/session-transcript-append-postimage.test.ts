import { DatabaseSync, StatementSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { observeSqliteReadSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { getSqliteReadScopeRevision } from "../../infra/sqlite-schema-facts.js";
import { runOpenClawAgentWriteTransaction } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import { prepareSessionEntryReplacementPublication } from "./session-accessor.sqlite-replacement-state.js";
import { resolveSqliteTranscriptScope } from "./session-accessor.sqlite-scope.js";
import { appendTranscriptMessageInTransaction } from "./session-accessor.sqlite-transcript-message-append.js";
import {
  readCommittedTranscriptMessageSequence,
  rememberCommittedTranscriptMessageSequencesInTransaction,
} from "./session-accessor.sqlite-transcript-sequences.js";
import { readTranscriptContextVersionInTransaction } from "./session-accessor.sqlite-transcript-state.js";
import { runTranscriptWriteSnapshotSync } from "./session-accessor.sqlite-transcript-write-snapshot.js";
import { appendTranscriptMessageSnapshotSync } from "./session-accessor.sqlite-transcript-write.js";
import { createSessionCompoundWorkerFixture } from "./session-compound-worker.test-support.js";
import { readSessionPendingInputAuthorityFacts } from "./session-pending-input-authority.kernel.js";
import { readTranscriptAppendPostimage } from "./session-transcript-append-postimage.js";

it.each([false, true])(
  "publishes the final append version after a later mutation: %s",
  async (mutate) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const f = createSessionCompoundWorkerFixture();
      const reads = observeSqliteReadSql(StatementSync.prototype);
      let checks = 0;
      const result = appendTranscriptMessageSnapshotSync(
        f.scope,
        { eventId: "message", message: { role: "assistant", content: "saved" } },
        undefined,
        undefined,
        {
          assertCurrent() {
            if (++checks === 2 && mutate) {
              f.database.db
                .prepare(
                  "UPDATE session_windows SET transcript_updated_at = 42 WHERE session_id = ?",
                )
                .run(f.scope.sessionId);
            }
          },
          onPendingTransaction() {},
        },
      );
      reads.restore();
      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error("Append refused");
      }
      expect(result.value.after).toEqual(
        readTranscriptContextVersionInTransaction(f.database, f.scope.sessionId),
      );
      expect(result.value.after.rawSeq).toBe(1);
      if (mutate) {
        expect(result.value.after.updatedAt).toBe(42);
      }
      // A fresh append already read its final version with its anchor. A later write expires it.
      expect(reads.queries.filter((sql) => sql.startsWith("select coalesce(")).length).toBe(
        mutate ? 2 : 1,
      );

      const foreign = new DatabaseSync(f.database.path);
      try {
        foreign
          .prepare("UPDATE transcript_rewrite_watermarks SET generation = ? WHERE session_id = ?")
          .run("foreign-generation", f.scope.sessionId);
      } finally {
        foreign.close();
      }
      const next = appendTranscriptMessageSnapshotSync(f.scope, {
        eventId: "next",
        message: { role: "assistant", content: "next saved" },
      });
      expect(next).toMatchObject({
        ok: true,
        value: {
          before: { generation: "foreign-generation", rawSeq: 1 },
          after: { generation: "foreign-generation", rawSeq: 2 },
        },
      });
    });
  },
);

it("shares committed entry facts with custody while retaining live member and row checks", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = createSessionCompoundWorkerFixture();
    runOpenClawAgentWriteTransaction((database) => {
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
      const reads = observeSqliteReadSql(StatementSync.prototype);
      const exec = vi.spyOn(database.db, "exec");
      try {
        const facts = readSessionPendingInputAuthorityFacts(
          database,
          f.scope.sessionKey,
          f.scope.agentId,
          postimage,
        );
        expect(facts.entry?.label).toBe("committed");
        expect(facts.members).toEqual([]);
        expect(reads.queries.filter((sql) => sql.includes('from "session_nodes"'))).toEqual([]);
        expect(exec).not.toHaveBeenCalled();
        if (facts.entry) {
          facts.entry.label = "caller-owned";
        }
        expect(postimage.entry.label).toBe("committed");
      } finally {
        exec.mockRestore();
        reads.restore();
      }
      writeSessionEntry(database, f.scope.sessionKey, {
        ...postimage.entry,
        label: "new writer",
        updatedAt: 3,
      });
      database.db
        .prepare(
          "INSERT INTO session_members (session_key, identity_id, added_by, added_at) VALUES (?, ?, ?, ?)",
        )
        .run(f.scope.sessionKey, "new-member", "owner", 1);
      const changed = readSessionPendingInputAuthorityFacts(
        database,
        f.scope.sessionKey,
        f.scope.agentId,
        postimage,
      );
      expect(changed.entry?.label).toBe("new writer");
      expect(changed.members).toMatchObject([{ identityId: "new-member" }]);
    }, f.scope);
  });
});

it.each([false, true])(
  "uses the append cursor only while its branch is current: %s",
  async (replaceBranch) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const f = createSessionCompoundWorkerFixture();
      const resolved = resolveSqliteTranscriptScope(f.scope);
      runOpenClawAgentWriteTransaction((database) => {
        const appended = appendTranscriptMessageInTransaction(database, resolved, {
          eventId: "first",
          message: { role: "assistant", content: "first branch" },
        });
        expect(appended).toBeDefined();
        if (!appended) {
          throw new Error("Missing append");
        }
        if (replaceBranch) {
          appendTranscriptMessageInTransaction(database, resolved, {
            eventId: "replacement",
            parentId: null,
            message: { role: "assistant", content: "replacement branch" },
          });
        }
        const reads = observeSqliteReadSql(StatementSync.prototype);
        try {
          rememberCommittedTranscriptMessageSequencesInTransaction(
            database,
            f.scope.sessionId,
            [appended.result],
            readTranscriptAppendPostimage(appended),
          );
          expect(readCommittedTranscriptMessageSequence(appended.result)).toBe(
            replaceBranch ? undefined : 1,
          );
          if (!replaceBranch) {
            expect(reads.queries).toEqual([]);
          }
        } finally {
          reads.restore();
        }
      }, f.scope);
    });
  },
);

it("preserves caller callback results without interpreting postimage-shaped fields", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = createSessionCompoundWorkerFixture();
    const value = { value: 7, postimage: "caller data" };
    const result = runTranscriptWriteSnapshotSync(f.scope, () => value);
    expect(result).toMatchObject({ ok: true, value: { result: value } });
  });
});

it("keeps snapshot versions scoped to the requested session when a callback appends elsewhere", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = createSessionCompoundWorkerFixture();
    const other = { ...f.scope, sessionKey: "agent:main:other", sessionId: "other" };
    replaceSessionEntrySync(other, { sessionId: other.sessionId, updatedAt: 1 });
    const result = runTranscriptWriteSnapshotSync(f.scope, (database) =>
      appendTranscriptMessageInTransaction(database, resolveSqliteTranscriptScope(other), {
        eventId: "other-message",
        message: { role: "assistant", content: "other session" },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("Snapshot refused");
    }
    expect(result.value.result?.result).toMatchObject({
      appended: true,
      messageId: "other-message",
    });
    expect(readTranscriptContextVersionInTransaction(f.database, other.sessionId).rawSeq).toBe(1);
    expect(result.value.after).toEqual(result.value.before);
    expect(result.value.after).toEqual(
      readTranscriptContextVersionInTransaction(f.database, f.scope.sessionId),
    );
  });
});

it("reuses the write's context postimage and retires it after a raw write or rollback", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = createSessionCompoundWorkerFixture();
    runOpenClawAgentWriteTransaction((database) => {
      appendTranscriptMessageInTransaction(database, resolveSqliteTranscriptScope(f.scope), {
        eventId: "saved",
        message: { role: "assistant", content: "durable bytes" },
      });
      const reads = observeSqliteReadSql(StatementSync.prototype);
      const saved = readTranscriptContextVersionInTransaction(database, f.scope.sessionId);
      const changedCopy = readTranscriptContextVersionInTransaction(database, f.scope.sessionId);
      reads.restore();
      expect(reads.queries).toEqual([]);
      expect(saved.rawSeq).toBe(1);
      changedCopy.updatedAt = -1;
      expect(readTranscriptContextVersionInTransaction(database, f.scope.sessionId)).toEqual(saved);

      expect(() =>
        runOpenClawAgentWriteTransaction((nested) => {
          nested.db
            .prepare("UPDATE session_windows SET transcript_updated_at = ? WHERE session_id = ?")
            .run(42, f.scope.sessionId);
          expect(
            readTranscriptContextVersionInTransaction(nested, f.scope.sessionId).updatedAt,
          ).toBe(42);
          throw new Error("rollback nested context");
        }, f.scope),
      ).toThrow("rollback nested context");
      expect(readTranscriptContextVersionInTransaction(database, f.scope.sessionId)).toEqual(saved);
    }, f.scope);
  });
});
