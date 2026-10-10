import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { runSqliteImmediateTransactionSync } from "../../infra/sqlite-transaction.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import {
  replaceTranscriptEventsSync,
  loadTranscriptEventsSync,
  resolveSessionTranscriptDatabasePath,
  upsertSessionEntryCore,
  validatePreparedAssistantAppendSync,
  type TranscriptEvent,
} from "./session-accessor.js";
import { resolveTranscriptMessageAppendParent } from "./session-accessor.sqlite-transcript-parent.js";
import {
  appendTranscriptEventSnapshotSync,
  appendTranscriptMessageSnapshotSync,
} from "./session-accessor.sqlite-transcript-write.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-ancestry-");

async function createTranscript(events: TranscriptEvent[]) {
  const scope = {
    agentId: "main",
    sessionId: "ancestry",
    sessionKey: "agent:main:ancestry",
    storePath: path.join(sessionDirs.make(), "sessions.json"),
  };
  await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
  replaceTranscriptEventsSync(scope, [
    { type: "session", version: 3, id: scope.sessionId },
    ...events,
  ]);
  return {
    scope,
    database: openOpenClawAgentDatabase({
      agentId: scope.agentId,
      path: resolveSessionTranscriptDatabasePath(scope),
    }),
  };
}

function message(id: string, parentId: string | null): TranscriptEvent {
  return { type: "message", id, parentId, message: { role: "user", content: id } };
}

it.each(["event", "message"] as const)(
  "keeps %s append rollback with its owning worker transaction without a savepoint",
  async (kind) => {
    const { database, scope } = await createTranscript([message("root", null)]);
    const before = loadTranscriptEventsSync(scope);
    expect(() =>
      appendTranscriptMessageSnapshotSync(
        scope,
        { eventId: "outside-transaction", message: { role: "assistant", content: "refused" } },
        undefined,
        undefined,
        undefined,
        database,
      ),
    ).toThrow("Transcript write lost its owning transaction");
    const transactionSql = vi.spyOn(database.db, "exec");
    try {
      expect(() =>
        runOpenClawAgentWriteTransaction(
          (current) => {
            const snapshot =
              kind === "event"
                ? appendTranscriptEventSnapshotSync(
                    scope,
                    { type: "custom", id: "rolled-back", parentId: "root" },
                    {},
                    undefined,
                    undefined,
                    current,
                  )
                : appendTranscriptMessageSnapshotSync(
                    scope,
                    { eventId: "rolled-back", message: { role: "assistant", content: "refused" } },
                    undefined,
                    undefined,
                    undefined,
                    current,
                  );
            expect(snapshot.ok).toBe(true);
            throw new Error("owning request refused commit");
          },
          { agentId: scope.agentId, path: database.path },
        ),
      ).toThrow("owning request refused commit");
      expect(transactionSql.mock.calls.some(([sql]) => /SAVEPOINT/i.test(sql))).toBe(false);
    } finally {
      transactionSql.mockRestore();
    }
    expect(loadTranscriptEventsSync(scope)).toEqual(before);
    const next = appendTranscriptMessageSnapshotSync(scope, {
      eventId: "committed",
      message: { role: "assistant", content: "accepted" },
    });
    expect(next).toMatchObject({ ok: true, value: { result: { messageId: "committed" } } });
  },
);

it.each(["dirty", "unclassified"] as const)(
  "shares append metadata without retaining facts across rollback or foreign %s writes",
  async (change) => {
    const { database, scope } = await createTranscript([
      message("root", null),
      message("tail", "root"),
    ]);
    const append = (id: string, parentId: string) => {
      const snapshot = appendTranscriptMessageSnapshotSync(scope, {
        eventId: id,
        parentId,
        message: { role: "assistant", content: id },
      });
      if (!snapshot.ok) {
        throw new Error(`Append refused: ${snapshot.error.code}`);
      }
      return snapshot.value;
    };
    const queries = trackSqliteStatementExecutions(database.db, ["projection", "tail"], (sql) => {
      if (!/^select /i.test(sql)) {
        return null;
      }
      if (sql.includes('"session_transcript_index_state"')) {
        return "projection";
      }
      return /^select "seq" from "transcript_events"/i.test(sql) &&
        sql.includes('order by "seq" desc')
        ? "tail"
        : null;
    });
    let first: ReturnType<typeof append>;
    try {
      first = append("answer", "tail");
      expect(queries.counts).toEqual({ projection: 2, tail: 0 });
    } finally {
      queries.restore();
    }
    expect(first.result?.anchor).toMatchObject({
      entryId: "answer",
      rawSeq: 3,
      activeMessagePosition: 2,
      effectiveParentId: "tail",
    });
    expect(first.visibleTail).toEqual({ entryId: "answer", generation: first.after.generation });
    expect(() =>
      runOpenClawAgentWriteTransaction(
        () => {
          expect(append("rolled-back", "answer").visibleTail.entryId).toBe("rolled-back");
          throw new Error("rollback append");
        },
        { agentId: scope.agentId, path: database.path },
      ),
    ).toThrow("rollback append");
    const second = append("after-rollback", "answer");
    expect(second.result?.anchor).toMatchObject({
      entryId: "after-rollback",
      rawSeq: 4,
      activeMessagePosition: 3,
    });

    const peer = new (requireNodeSqlite().DatabaseSync)(database.path);
    try {
      peer
        .prepare(
          change === "dirty"
            ? "UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?"
            : "UPDATE session_transcript_active_events SET context_eligible = NULL WHERE session_id = ?",
        )
        .run(scope.sessionId);
    } finally {
      peer.close();
    }
    const fresh = append("after-foreign", "after-rollback");
    expect(fresh.result?.anchor).toBeUndefined();
    expect(fresh.visibleTail).toEqual({
      entryId: "after-foreign",
      generation: fresh.after.generation,
    });
  },
);

it("returns the newer visible tail after native identity-insert reentry", async () => {
  const { scope } = await createTranscript([message("root", null)]);
  const { StatementSync } = requireNodeSqlite();
  // oxlint-disable-next-line typescript/unbound-method -- Forwarded below with the original native receiver.
  const original = StatementSync.prototype.run;
  let reentered = false;
  const spy = vi.spyOn(StatementSync.prototype, "run").mockImplementation(
    new Proxy(original, {
      apply(target, receiver, args) {
        const value = Reflect.apply(target, receiver, args);
        if (
          !reentered &&
          receiver.sourceSQL.startsWith('insert into "transcript_event_identities"') &&
          args.includes("outer")
        ) {
          reentered = true;
          const nested = appendTranscriptMessageSnapshotSync(scope, {
            eventId: "nested",
            parentId: "outer",
            message: { role: "assistant", content: "nested" },
          });
          expect(nested.ok).toBe(true);
        }
        return value;
      },
    }),
  );
  try {
    const result = appendTranscriptMessageSnapshotSync(scope, {
      eventId: "outer",
      parentId: "root",
      message: { role: "assistant", content: "outer" },
    });
    expect(reentered).toBe(true);
    expect(result).toMatchObject({
      ok: true,
      value: {
        result: { messageId: "outer", anchor: { entryId: "outer", rawSeq: 2 } },
        visibleTail: { entryId: "nested" },
        after: { rawSeq: 3 },
      },
    });
  } finally {
    spy.mockRestore();
  }
});

describe("SQLite transcript append ancestry", () => {
  const linear = [message("root", null), message("tail", "root")];
  const cycle = [message("cycle-a", "cycle-b"), message("cycle-b", "cycle-a")];
  it.each([
    {
      name: "dangling ancestor",
      events: [message("tail", "missing")],
      parentId: "missing",
      expected: "tail",
    },
    { name: "unrelated cycle", events: cycle, parentId: "outside", expected: "outside" },
    { name: "cycle without root", events: cycle, parentId: null, expected: null },
    {
      name: "invalid leaf navigation fallback",
      events: [...linear, { type: "leaf", id: "invalid", parentId: "tail", targetId: "missing" }],
      parentId: "root",
      expected: "tail",
    },
    {
      name: "parentless navigation fallback",
      events: [
        ...linear,
        { type: "message", id: "parentless", message: { role: "user", content: "late" } },
      ],
      parentId: "root",
      expected: "root",
    },
  ])("preserves $name", async ({ events, parentId, expected }) => {
    const { database, scope } = await createTranscript(events);
    expect(
      runSqliteImmediateTransactionSync(database.db, () =>
        resolveTranscriptMessageAppendParent(database, scope.sessionId, {
          appendIntent: "active-branch",
          parentId,
        }),
      ),
    ).toBe(expected);
  });

  it("does not traverse an ancestor from another session", async () => {
    const { database, scope } = await createTranscript([message("tail", "foreign")]);
    const other = { ...scope, sessionId: "other", sessionKey: "agent:main:other" };
    await upsertSessionEntryCore(other, { sessionId: other.sessionId, updatedAt: 1 });
    replaceTranscriptEventsSync(other, [message("foreign", "root")]);
    expect(
      runSqliteImmediateTransactionSync(database.db, () =>
        resolveTranscriptMessageAppendParent(database, scope.sessionId, {
          appendIntent: "active-branch",
          parentId: "root",
        }),
      ),
    ).toBe("root");
  });
});

it.each(["missing-prepared", "missing-admitted", "overflow-prepared"] as const)(
  "preserves prepared assistant %s refusal before parsing newer messages",
  async (scenario) => {
    const { database, scope } = await createTranscript([
      message("admitted", null),
      message("prepared", "admitted"),
      message("poison", "prepared"),
      message("tail", "poison"),
    ]);
    database.db
      .prepare("UPDATE transcript_events SET event_json = '{' WHERE session_id = ? AND seq = 3")
      .run(scope.sessionId);
    if (scenario === "overflow-prepared") {
      runSqliteImmediateTransactionSync(database.db, () => {
        database.db.exec("PRAGMA defer_foreign_keys = ON");
        const offset = 9007199254740993n;
        database.db
          .prepare("UPDATE transcript_events SET seq = seq + ? WHERE session_id = ?")
          .run(offset, scope.sessionId);
        database.db
          .prepare("UPDATE transcript_event_identities SET seq = seq + ? WHERE session_id = ?")
          .run(offset, scope.sessionId);
        database.db
          .prepare(
            "UPDATE session_transcript_active_events SET event_seq = event_seq + ? WHERE session_id = ?",
          )
          .run(offset, scope.sessionId);
      });
      expect(() => validatePreparedAssistantAppendSync(scope, "prepared", "prepared")).toThrow(
        expect.objectContaining({ code: "ERR_OUT_OF_RANGE" }),
      );
    } else {
      database.db
        .prepare("DELETE FROM transcript_event_identities WHERE session_id = ? AND event_id = ?")
        .run(scope.sessionId, scenario === "missing-prepared" ? "prepared" : "admitted");
      expect(
        validatePreparedAssistantAppendSync(
          scope,
          "prepared",
          scenario === "missing-prepared" ? "prepared" : "admitted",
        ),
      ).toBeUndefined();
    }
    expect(database.db.isTransaction).toBe(false);
  },
);
