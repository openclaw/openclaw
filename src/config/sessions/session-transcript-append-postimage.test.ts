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
  rememberCommittedTranscriptMessageSequencesInTransaction as rememberSequencesInTransaction,
} from "./session-accessor.sqlite-transcript-sequences.js";
import { readTranscriptContextVersionInTransaction as readVersion } from "./session-accessor.sqlite-transcript-state.js";
import { runTranscriptWriteSnapshotSync as writeSnapshot } from "./session-accessor.sqlite-transcript-write-snapshot.js";
import { appendTranscriptMessageSnapshotSync as appendSnapshot } from "./session-accessor.sqlite-transcript-write.js";
import { createSessionCompoundWorkerFixture } from "./session-compound-worker.test-support.js";
import { readSessionPendingInputAuthorityFacts } from "./session-pending-input-authority.kernel.js";
import { readTranscriptAppendPostimage } from "./session-transcript-append-postimage.js";

function withFixture(
  run: (fixture: ReturnType<typeof createSessionCompoundWorkerFixture>) => void | Promise<void>,
) {
  return withOpenClawTestState({ scenario: "minimal" }, async () =>
    run(createSessionCompoundWorkerFixture()),
  );
}

function event(eventId: string, parentId?: null) {
  return {
    eventId,
    ...(parentId === null ? { parentId } : {}),
    message: { role: "assistant" as const, content: eventId },
  };
}

it.each([false, true])(
  "publishes the final append version after a later mutation: %s",
  async (mutate) => {
    await withFixture(async (f) => {
      const reads = observeSqliteReadSql(StatementSync.prototype);
      let checks = 0;
      const result = appendSnapshot(
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
      expect(result.value.after).toEqual(readVersion(f.database, f.scope.sessionId));
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
      const next = appendSnapshot(f.scope, {
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
  await withFixture((f) => {
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
    await withFixture((f) => {
      const resolved = resolveSqliteTranscriptScope(f.scope);
      writeTransaction((database) => {
        const appended = appendMessage(database, resolved, event("first"));
        expect(appended).toBeDefined();
        if (!appended) {
          throw new Error("Missing append");
        }
        if (replaceBranch) {
          appendMessage(database, resolved, event("replacement", null));
        }
        const reads = observeSqliteReadSql(StatementSync.prototype);
        try {
          rememberSequencesInTransaction(
            database,
            f.scope.sessionId,
            [appended.result],
            readTranscriptAppendPostimage(appended),
          );
          expect(readSequence(appended.result)).toBe(replaceBranch ? undefined : 1);
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

it.each([false, true])(
  "publishes only ready final turn cursors through the history worker: branch changed %s",
  async (replaceBranch) => {
    await withFixture(async (f) => {
      const resolved = resolveSqliteTranscriptScope(f.scope);
      const { first: firstMessage, second: secondMessage } = writeTransaction((database) => {
        const first = appendMessage(database, resolved, event("first"));
        const second = appendMessage(
          database,
          resolved,
          event("second", replaceBranch ? null : undefined),
        );
        if (!first || !second) {
          throw new Error("Missing committed messages");
        }
        return { first: first.result, second: second.result };
      }, f.scope);
      const reads = observeSqliteReadSql(StatementSync.prototype);
      try {
        await rememberSequences(f.scope, [firstMessage, secondMessage]);
        expect(readSequence(firstMessage)).toBe(replaceBranch ? undefined : 1);
        // An explicit branch change invalidates the projection until its owner rebuilds it.
        expect(readSequence(secondMessage)).toBe(replaceBranch ? undefined : 2);
        expect(reads.queries).toEqual([]);
      } finally {
        reads.restore();
      }
    });
  },
);

it("preserves caller callback results without interpreting postimage-shaped fields", async () => {
  await withFixture((f) => {
    const value = { value: 7, postimage: "caller data" };
    const result = writeSnapshot(f.scope, () => value);
    expect(result).toMatchObject({ ok: true, value: { result: value } });
  });
});

it("keeps snapshot versions scoped to the requested session when a callback appends elsewhere", async () => {
  await withFixture((f) => {
    const other = { ...f.scope, sessionKey: "agent:main:other", sessionId: "other" };
    replaceSessionEntrySync(other, { sessionId: other.sessionId, updatedAt: 1 });
    const result = writeSnapshot(f.scope, (database) =>
      appendMessage(database, resolveSqliteTranscriptScope(other), event("other-message")),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("Snapshot refused");
    }
    expect(result.value.result?.result).toMatchObject({
      appended: true,
      messageId: "other-message",
    });
    expect(readVersion(f.database, other.sessionId).rawSeq).toBe(1);
    expect(result.value.after).toEqual(result.value.before);
    expect(result.value.after).toEqual(readVersion(f.database, f.scope.sessionId));
  });
});

it("reuses the write's context postimage and retires it after a raw write or rollback", async () => {
  await withFixture((f) => {
    writeTransaction((database) => {
      appendMessage(database, resolveSqliteTranscriptScope(f.scope), event("saved"));
      const reads = observeSqliteReadSql(StatementSync.prototype);
      const saved = readVersion(database, f.scope.sessionId);
      const changedCopy = readVersion(database, f.scope.sessionId);
      reads.restore();
      expect(reads.queries).toEqual([]);
      expect(saved.rawSeq).toBe(1);
      changedCopy.updatedAt = -1;
      expect(readVersion(database, f.scope.sessionId)).toEqual(saved);

      expect(() =>
        writeTransaction((nested) => {
          nested.db
            .prepare("UPDATE session_windows SET transcript_updated_at = ? WHERE session_id = ?")
            .run(42, f.scope.sessionId);
          expect(readVersion(nested, f.scope.sessionId).updatedAt).toBe(42);
          throw new Error("rollback nested context");
        }, f.scope),
      ).toThrow("rollback nested context");
      expect(readVersion(database, f.scope.sessionId)).toEqual(saved);
    }, f.scope);
  });
});
