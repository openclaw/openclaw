import assert from "node:assert/strict";
import path from "node:path";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { runSqliteImmediateTransactionSync } from "../../infra/sqlite-transaction.js";
import {
  openOpenClawAgentDatabase as openDatabase,
  runOpenClawAgentWriteTransaction as writeTransaction,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import {
  loadTranscriptEventsSync as loadEvents,
  resolveSessionTranscriptDatabasePath as databasePath,
  upsertSessionEntryCore as upsertEntry,
  validatePreparedAssistantAppendSync as validatePrepared,
  type TranscriptEvent,
} from "./session-accessor.js";
import { resolveSqliteTranscriptScope } from "./session-accessor.sqlite-scope.js";
import { resolveTranscriptMessageAppendParent as resolveParent } from "./session-accessor.sqlite-transcript-parent.js";
import { readTranscriptAppendStateInTransaction } from "./session-accessor.sqlite-transcript-state.js";
import {
  appendTranscriptEventSnapshotSync as appendEvent,
  appendTranscriptMessageSnapshotSync as appendMessage,
} from "./session-accessor.sqlite-transcript-write.kernel.js";
import { replaceTranscriptEventsSync as replaceEvents } from "./session-accessor.sqlite-transcript-write.test-support.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-ancestry-");
afterEach(() => vi.restoreAllMocks());

async function createTranscript(events: TranscriptEvent[] = chain("root")) {
  const scope = {
    agentId: "main",
    sessionId: "ancestry",
    sessionKey: "agent:main:ancestry",
    storePath: path.join(sessionDirs.make(), "sessions.json"),
  };
  await upsertEntry(scope, { sessionId: scope.sessionId, updatedAt: 1 });
  replaceEvents(scope, [{ type: "session", version: 3, id: scope.sessionId }, ...events]);
  const database = openDatabase({ agentId: scope.agentId, path: databasePath(scope) });
  return {
    scope,
    database,
    append: (id: string, parentId?: string, owner?: OpenClawAgentDatabase) =>
      appendMessage(scope, assistant(id, parentId), undefined, undefined, undefined, owner),
    transaction: <T>(operation: (current: OpenClawAgentDatabase) => T) =>
      writeTransaction(operation, { agentId: scope.agentId, path: database.path }),
    parent: (parentId: string | null | undefined, prepared = false) =>
      runSqliteImmediateTransactionSync(database.db, () =>
        resolveParent(
          database,
          scope.sessionId,
          { appendIntent: "active-branch", parentId },
          prepared
            ? readTranscriptAppendStateInTransaction(
                database,
                resolveSqliteTranscriptScope(scope),
                true,
              ).parent
            : undefined,
        ),
      ),
  };
}

function message(id: string, parentId: string | null): TranscriptEvent {
  return { type: "message", id, parentId, message: { role: "user", content: id } };
}

const chain = (...ids: string[]) => ids.map((id, index) => message(id, ids[index - 1] ?? null));

function assistant(eventId: string, parentId?: string) {
  return { eventId, parentId, message: { role: "assistant", content: eventId } };
}

it.each(["event", "message"] as const)(
  "keeps %s append rollback with its owning worker transaction",
  async (kind) => {
    const { database, scope, append, transaction } = await createTranscript();
    const before = loadEvents(scope);
    expect(() => append("outside-transaction", undefined, database)).toThrow(
      "Transcript write lost its owning transaction",
    );
    expect(() =>
      transaction((current) => {
        const event = { type: "custom", id: "rolled-back", parentId: "root" };
        const snapshot =
          kind === "event"
            ? appendEvent(scope, event, {}, undefined, undefined, current)
            : append("rolled-back", undefined, current);
        expect(snapshot.ok).toBe(true);
        throw new Error("owning request refused commit");
      }),
    ).toThrow("owning request refused commit");
    expect(loadEvents(scope)).toEqual(before);
    const next = append("committed");
    expect(next).toMatchObject({ ok: true, value: { result: { messageId: "committed" } } });
  },
);

it.each(["dirty", "unclassified"] as const)(
  "shares append metadata without retaining facts across rollback or foreign %s writes",
  async (change) => {
    const fixture = await createTranscript(chain("root", "tail"));
    const { database, scope, transaction } = fixture;
    const append = (id: string, parentId: string) => {
      const snapshot = fixture.append(id, parentId);
      assert(snapshot.ok);
      return snapshot.value;
    };
    const first = append("answer", "tail");
    expect(first.result?.anchor).toMatchObject({
      entryId: "answer",
      rawSeq: 3,
      activeMessagePosition: 2,
      effectiveParentId: "tail",
    });
    expect(first.visibleTail).toEqual({ entryId: "answer", generation: first.after.generation });
    expect(() =>
      transaction(() => {
        expect(append("rolled-back", "answer").visibleTail.entryId).toBe("rolled-back");
        throw new Error("rollback append");
      }),
    ).toThrow("rollback append");
    const second = append("after-rollback", "answer");
    expect(second.result?.anchor).toMatchObject({
      entryId: "after-rollback",
      rawSeq: 4,
      activeMessagePosition: 3,
    });

    {
      using peer = new (requireNodeSqlite().DatabaseSync)(database.path);
      peer
        .prepare(
          change === "dirty"
            ? "UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?"
            : "UPDATE session_transcript_active_events SET context_eligible = NULL WHERE session_id = ?",
        )
        .run(scope.sessionId);
    }
    const { result, visibleTail, after } = append("after-foreign", "after-rollback");
    expect(result?.anchor).toBeUndefined();
    expect(visibleTail).toEqual({ entryId: "after-foreign", generation: after.generation });
  },
);

it("returns the newer visible tail after native identity-insert reentry", async () => {
  const { append } = await createTranscript();
  const { StatementSync } = requireNodeSqlite();
  // oxlint-disable-next-line typescript/unbound-method -- Forwarded below with the original native receiver.
  const original = StatementSync.prototype.run;
  let reentered = false;
  vi.spyOn(StatementSync.prototype, "run").mockImplementation(
    new Proxy(original, {
      apply(target, receiver, args) {
        const value = Reflect.apply(target, receiver, args);
        if (
          !reentered &&
          receiver.sourceSQL.startsWith('insert into "transcript_event_identities"') &&
          args.includes("outer")
        ) {
          reentered = true;
          expect(append("nested", "outer").ok).toBe(true);
        }
        return value;
      },
    }),
  );
  const result = append("outer", "root");
  expect(reentered).toBe(true);
  expect(result).toMatchObject({
    ok: true,
    value: {
      result: { messageId: "outer", anchor: { entryId: "outer", rawSeq: 2 } },
      visibleTail: { entryId: "nested" },
      after: { rawSeq: 3 },
    },
  });
});

const linear = chain("root", "tail");
const cycle = [message("cycle-a", "cycle-b"), message("cycle-b", "cycle-a")];
const invalidLeaf = { type: "leaf", id: "invalid", parentId: "tail", targetId: "missing" };
const parentless = {
  type: "message",
  id: "parentless",
  message: { role: "user", content: "late" },
};
it.each([
  ["linear ancestor", linear, "root", "tail"],
  ["dangling ancestor", [message("tail", "missing")], "missing", "tail"],
  ["unrelated cycle", cycle, "outside", "outside"],
  ["cycle without root", cycle, null, null],
  ["invalid leaf navigation fallback", [...linear, invalidLeaf], "root", "tail"],
  ["parentless navigation fallback", [...linear, parentless], "root", "root"],
  [
    "valid leaf navigation",
    [...linear, { type: "leaf", id: "selected", parentId: "tail", targetId: "root" }],
    "root",
    "root",
  ],
  ["header without identity", [], null, null],
  ["dirty projection", linear, "root", "tail", "dirty"],
  ["unclassified projection", linear, "root", "tail", "unclassified"],
  ["identity-less explicit parent", linear, "root", "root", "without-identities"],
  ["identity-less dirty fallback", linear, undefined, "tail", "without-identities-dirty"],
] satisfies [
  string,
  TranscriptEvent[],
  string | null | undefined,
  string | null,
  ("dirty" | "unclassified" | "without-identities" | "without-identities-dirty")?,
][])(
  "preserves %s",
  async (
    _name,
    events,
    parentId,
    expected,
    projection?: "dirty" | "unclassified" | "without-identities" | "without-identities-dirty",
  ) => {
    const { database, scope, parent, transaction } = await createTranscript(events);
    transaction(() => {
      if (projection?.startsWith("without-identities")) {
        database.db
          .prepare("DELETE FROM transcript_event_identities WHERE session_id = ?")
          .run(scope.sessionId);
      }
      if (projection === "dirty" || projection === "without-identities-dirty") {
        database.db
          .prepare(
            "UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?",
          )
          .run(scope.sessionId);
      } else if (projection === "unclassified") {
        database.db
          .prepare(
            "UPDATE session_transcript_active_events SET context_eligible = NULL WHERE session_id = ?",
          )
          .run(scope.sessionId);
      }
    });
    expect(parent(parentId)).toBe(expected);
    expect(parent(parentId, true)).toBe(expected);
  },
);

it("does not traverse an ancestor from another session", async () => {
  const { scope, parent } = await createTranscript([message("tail", "foreign")]);
  const other = { ...scope, sessionId: "other", sessionKey: "agent:main:other" };
  await upsertEntry(other, { sessionId: other.sessionId, updatedAt: 1 });
  replaceEvents(other, [message("foreign", "root")]);
  expect(parent("root")).toBe("root");
});

it.each(["missing-prepared", "missing-admitted", "overflow-prepared"] as const)(
  "preserves prepared assistant %s refusal before parsing newer messages",
  async (scenario) => {
    const { database, scope } = await createTranscript(
      chain("admitted", "prepared", "poison", "tail"),
    );
    database.db
      .prepare("UPDATE transcript_events SET event_json = '{' WHERE session_id = ? AND seq = 3")
      .run(scope.sessionId);
    if (scenario === "overflow-prepared") {
      runSqliteImmediateTransactionSync(database.db, () => {
        database.db.exec("PRAGMA defer_foreign_keys = ON");
        const offset = 9007199254740993n;
        for (const query of [
          "UPDATE transcript_events SET seq = seq + ? WHERE session_id = ?",
          "UPDATE transcript_event_identities SET seq = seq + ? WHERE session_id = ?",
          "UPDATE session_transcript_active_events SET event_seq = event_seq + ? WHERE session_id = ?",
        ]) {
          database.db.prepare(query).run(offset, scope.sessionId);
        }
      });
      expect(() => validatePrepared(scope, "prepared", "prepared")).toThrow(
        expect.objectContaining({ code: "ERR_OUT_OF_RANGE" }),
      );
    } else {
      const admitted = scenario === "missing-prepared" ? "prepared" : "admitted";
      database.db
        .prepare("DELETE FROM transcript_event_identities WHERE session_id = ? AND event_id = ?")
        .run(scope.sessionId, admitted);
      expect(validatePrepared(scope, "prepared", admitted)).toBeUndefined();
    }
    expect(database.db.isTransaction).toBe(false);
  },
);
