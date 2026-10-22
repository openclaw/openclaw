import type { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import {
  type OpenClawAgentDatabase,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import type { TranscriptEvent } from "./session-accessor.sqlite-contract.js";
import { readActiveTranscriptStats } from "./session-accessor.sqlite-history.test-support.js";
import {
  readTranscriptEventRows,
  readTranscriptStatsSync,
  readTranscriptStorageRows,
  type SqliteTranscriptSnapshotRow,
} from "./session-accessor.sqlite-read.js";
import {
  readTranscriptGenerationInTransaction,
  readTranscriptMutationStateInTransaction,
} from "./session-accessor.sqlite-transcript-state.js";
import {
  appendTranscriptEventInTransaction,
  appendTranscriptEventsInTransaction,
  replaceSqliteTranscriptEventsInTransaction,
  rewriteSqliteTranscriptEventRowsInTransaction,
  updateSqliteTranscriptEventJsonInTransaction,
} from "./session-accessor.sqlite-transcript-store.js";
import { replaceSqliteTranscriptSuffixInTransaction } from "./session-accessor.sqlite-transcript-suffix.js";
import { SqliteTranscriptMutationConflictError } from "./session-mutation-conflict-error.js";
import {
  SYNC_REBUILD_MAX_BYTES,
  SYNC_REBUILD_MAX_ROWS,
  sessionTranscriptIndexNeedsReconcile,
} from "./session-transcript-index.js";
import { SessionTranscriptProjectionUnavailableError } from "./session-transcript-projection-error.js";
import { waitForSessionTranscriptIndexReconcile } from "./session-transcript-reconcile.js";
import { searchSessionTranscriptsReadOnlySync as searchSessionTranscripts } from "./session-transcript-search.js";

const mediaMessage = (id: string, content: string) => ({
  type: "message",
  id,
  parentId: null,
  message: { role: "assistant", content, MediaPaths: ["/media/a.png"], MediaTypes: ["image/png"] },
});

it("captures the replacement's stored rows after media normalization and duplicate filtering", async () => {
  await withOpenClawTestState({ label: "replacement-snapshot" }, async (state) => {
    const { scope, owner: database, db, replace } = createTranscriptFixture(state, "replacement");
    const message = mediaMessage("answer", "large payload ".repeat(1024));
    const unicode = { type: "custom", id: "unicode", data: "\ud800\u0000" };
    const rows = replace([
      message,
      { ...message, message: { role: "assistant", content: "ignored duplicate" } },
      unicode,
    ]);
    expect(rows.map((row) => row.seq)).toEqual([0, 1]);
    expect(JSON.parse(rows[0]!.eventJson).message).toMatchObject({
      content: message.message.content,
      __openclaw: { media: [expect.objectContaining({ path: "/media/a.png" })] },
    });
    expect(JSON.parse(rows[0]!.eventJson).message).not.toHaveProperty("MediaPaths");
    expect(JSON.parse(rows[1]!.eventJson)).toEqual(unicode);
    expect(rows).toEqual(readTranscriptEventRows(database, scope.sessionId));
    using work = observeSql(db, ["identityDeletes"], (sql) =>
      /^delete from "transcript_event_identities" /i.test(sql) ? "identityDeletes" : null,
    );
    const emptyRows = replace([]);
    expect(work.counts.identityDeletes).toBe(0);
    expect(emptyRows).toEqual([]);
    expect(readTranscriptEventRows(database, scope.sessionId)).toEqual([]);
    const identities = database.db
      .prepare("SELECT event_id FROM transcript_event_identities WHERE session_id = ?")
      .all(scope.sessionId);
    expect(identities).toEqual([]);
  });
});

it("canonicalizes assistant media at the generic transcript append owner", async () => {
  await withOpenClawTestState({ label: "media-persistence-append" }, async (state) => {
    const { scope, owner: database, db, append } = createTranscriptFixture(state, "append-session");
    const committedJson = append({ ...mediaMessage("event-1", "append"), timestamp: 1000 });
    const row = database.db
      .prepare("SELECT event_json FROM transcript_events WHERE session_id = ? AND seq = 0")
      .get(scope.sessionId) as { event_json: string };
    expect(committedJson).toBe(row.event_json);
    const message = (JSON.parse(row.event_json) as { message: Record<string, unknown> }).message;
    expect(message).toMatchObject({ role: "assistant", content: "append" });
    expect(message).not.toHaveProperty("MediaPaths");
    expect(message).not.toHaveProperty("MediaTypes");
    expect(message["__openclaw"]).toMatchObject({
      media: [expect.objectContaining({ path: "/media/a.png", contentType: "image/png" })],
    });

    const generation = readTranscriptGenerationInTransaction(database, scope.sessionId);
    const next = {
      type: "message",
      id: "event-2",
      parentId: "event-1",
      timestamp: 1001,
      message: { role: "assistant", content: "next" },
    };
    using policy = observeSql(db, ["policy"], (sql) =>
      sql.includes('"session_key_contract"') ? "policy" : null,
    );
    const nextJson = append(next);
    expect(nextJson).toBe(JSON.stringify(next));
    expect(
      database.db
        .prepare("SELECT seq, event_json FROM transcript_events WHERE session_id = ? ORDER BY seq")
        .all(scope.sessionId),
    ).toEqual([
      { seq: 0, event_json: committedJson },
      { seq: 1, event_json: nextJson },
    ]);
    expect(readTranscriptGenerationInTransaction(database, scope.sessionId)).toBe(generation);
    expect(policy).toMatchObject({
      counts: { policy: 0 },
      rowCounts: { policy: 0 },
      textBytes: { policy: 0 },
    });
  });
});

const rewriteEvents = [
  { type: "custom", id: "root", parentId: null },
  { type: "message", id: "user", parentId: "root", message: { role: "user", content: "question" } },
  {
    type: "message",
    id: "answer",
    parentId: "user",
    message: { role: "assistant", content: "answer" },
  },
] as const;

function rewriteMessage(index: 1 | 2, message: Record<string, unknown>) {
  return { ...rewriteEvents[index], message: { ...rewriteEvents[index].message, ...message } };
}

function detailedEvents(details: Record<string, unknown>) {
  return [rewriteEvents[0], rewriteMessage(1, { details }), rewriteMessage(2, { details })];
}

async function withRewriteFixture(
  run: (fixture: ReturnType<typeof createRewriteFixture>) => void | Promise<void>,
  events: readonly unknown[] = rewriteEvents,
) {
  await withOpenClawTestState({ label: "exact-rewrite" }, async (state) =>
    run(createRewriteFixture(state, events)),
  );
}

function observeSql<Key extends string>(
  db: DatabaseSync,
  keys: readonly Key[],
  classify: (sql: string) => Key | null,
) {
  const counter = trackSqliteStatementExecutions(db, keys, classify);
  return { ...counter, [Symbol.dispose]: counter.restore };
}

function createTranscriptFixture(state: OpenClawTestState, sessionId: string) {
  const scope = {
    agentId: "main",
    sessionId,
    sessionKey: `agent:main:${sessionId}`,
    env: state.env,
  };
  const owner = openOpenClawAgentDatabase(scope);
  const db = requireNativeSqliteDatabase(owner.db);
  const write = <T>(run: (database: OpenClawAgentDatabase) => T) =>
    runOpenClawAgentWriteTransaction(run, scope);
  const append = (event: TranscriptEvent) =>
    write((database) => appendTranscriptEventInTransaction(database, scope, event));
  const replace = (events: readonly TranscriptEvent[]) => {
    const writtenRows: SqliteTranscriptSnapshotRow[] = [];
    write((database) =>
      replaceSqliteTranscriptEventsInTransaction(database, scope, events, { writtenRows }),
    );
    return writtenRows;
  };
  return { scope, owner, db, write, append, replace };
}

function createRewriteFixture(state: OpenClawTestState, events: readonly unknown[]) {
  const { scope, owner, db, write } = createTranscriptFixture(state, "rewrite");
  write((database) => {
    appendTranscriptEventsInTransaction(database, scope, events);
  });
  const rows = (table: string, order = "seq") =>
    db
      .prepare(`SELECT * FROM ${table} WHERE session_id = ? ORDER BY ${order}`)
      .all(scope.sessionId);
  const setKeyOwner = (eventId: string, key: string | null) => {
    db.prepare(
      "UPDATE transcript_event_identities SET message_idempotency_key = ? WHERE session_id = ? AND event_id = ?",
    ).run(key, scope.sessionId, eventId);
  };
  const snapshot = () => ({
    raw: readTranscriptStorageRows(owner, scope.sessionId).map((row) => ({
      session_id: scope.sessionId,
      seq: row.seq,
      event_json: row.eventJson,
      created_at: row.createdAt,
    })),
    storage: rows("transcript_events"),
    identities: rows("transcript_event_identities"),
    active: rows("session_transcript_active_events", "active_position"),
    search: rows("session_transcript_fts", "message_id"),
    generation: readTranscriptGenerationInTransaction(owner, scope.sessionId),
    updatedAt: readTranscriptMutationStateInTransaction(owner, scope.sessionId).updatedAt,
  });
  const rewrite = (event: unknown, seq = 1) => {
    const row = readTranscriptEventRows(owner, scope.sessionId).find((entry) => entry.seq === seq);
    if (!row) {
      throw new Error("missing rewrite row");
    }
    const expectedEventJson = row.eventJson;
    write((database) => {
      rewriteSqliteTranscriptEventRowsInTransaction(database, scope, [
        { seq, event, expectedEventJson },
      ]);
    });
  };
  return { db, snapshot, rewrite, scope, write, setKeyOwner };
}

it("preserves the generation when initially recording identical model prompt text", async () => {
  await withRewriteFixture(({ snapshot, rewrite }) => {
    const before = snapshot();
    const message = {
      ...rewriteEvents[1].message,
      __openclaw: { modelPromptProjection: { version: 1, text: "question" } },
    };
    rewrite(rewriteMessage(1, message));
    const captured = snapshot();
    expect(captured.generation).toBe(before.generation);
    expect(captured.raw[1]?.event_json).toBe(JSON.stringify({ ...rewriteEvents[1], message }));
    rewrite(
      rewriteMessage(1, {
        ...message,
        __openclaw: { modelPromptProjection: { version: 1, text: "changed" } },
      }),
    );
    expect(snapshot().generation).not.toBe(captured.generation);
  });
});

it.each([
  { name: "content", message: { content: "changed" } },
  { name: "provenance", message: { provenance: { kind: "internal_system" } } },
  { name: "sender authority", metadata: { senderIsOwner: true } },
  {
    name: "model projection",
    metadata: { modelPromptProjection: { version: 1, text: "changed" } },
  },
  { name: "branch parent", envelope: { parentId: null } },
])(
  "invalidates admissions when steering metadata accompanies $name changes",
  async ({ message, metadata, envelope }) => {
    await withRewriteFixture(({ snapshot, rewrite }) => {
      const before = snapshot();
      rewrite({
        ...rewriteEvents[1],
        ...envelope,
        message: {
          ...rewriteEvents[1].message,
          ...message,
          __openclaw: { steerTargetRunId: "running-turn", ...metadata },
        },
      });
      expect(snapshot().generation).not.toBe(before.generation);
    });
  },
);

it("applies exact bindings across both storage arms", async () => {
  const details = { opaque: "preserved metadata ".repeat(2048) };
  const events = detailedEvents(details);
  await withRewriteFixture(({ snapshot, scope, write }) => {
    const before = snapshot();
    const first = rewriteMessage(2, { provenance: "first" });
    const last = rewriteMessage(2, { provenance: "last", details });
    const user = rewriteMessage(1, { provenance: "user" });
    expect(before.storage[1]?.event_json === null).toBe(true);
    expect(before.storage[2]?.event_zstd instanceof Uint8Array).toBe(true);
    using work = observeSql(
      requireNativeSqliteDatabase(openOpenClawAgentDatabase(scope).db),
      ["fts", "size"],
      (sql) =>
        /\bsession_transcript_fts\b/i.test(sql)
          ? "fts"
          : sql.includes('from "transcript_events"') && sql.includes("octet_length")
            ? "size"
            : null,
    );
    write((database) => {
      rewriteSqliteTranscriptEventRowsInTransaction(database, scope, [
        { seq: 2, expectedEventJson: JSON.stringify(events[2]), event: first },
        { seq: 1, expectedEventJson: JSON.stringify(events[1]), event: user },
        { seq: 2, expectedEventJson: JSON.stringify(first), event: last },
      ]);
    });
    expect(work.counts).toEqual({ fts: 0, size: 0 });
    const after = snapshot();
    expect(after.raw).toEqual([
      before.raw[0],
      { ...before.raw[1], event_json: JSON.stringify(user) },
      { ...before.raw[2], event_json: JSON.stringify(last) },
    ]);
    expect({ identities: after.identities, active: after.active, search: after.search }).toEqual({
      identities: before.identities,
      active: before.active,
      search: before.search,
    });
    expect(after.generation).not.toBe(before.generation);
    expect(after.updatedAt).toBeGreaterThan(before.updatedAt!);
    expect(after.storage[1]?.event_json === null).toBe(false);
    expect(after.storage[1]?.event_zstd instanceof Uint8Array).toBe(false);
    expect(after.storage[2]?.event_json === null).toBe(true);
    expect(after.storage[2]?.event_zstd instanceof Uint8Array).toBe(true);
    expect(readTranscriptStatsSync(scope)).toMatchObject({
      eventCount: 3,
      sizeBytes: Buffer.byteLength(
        [rewriteEvents[0], user, last].map((event) => JSON.stringify(event)).join("\n"),
      ),
    });
  }, events);
});

it("keeps oversized metadata current but hides changed text until the real worker reconciles", async () => {
  await withRewriteFixture(async ({ db, rewrite, scope }) => {
    const message = {
      ...rewriteEvents[1].message,
      provenance: "x".repeat(SYNC_REBUILD_MAX_BYTES + 1),
    };
    rewrite({ ...rewriteEvents[1], message });
    expect(sessionTranscriptIndexNeedsReconcile(db, scope.sessionId)).toBe(false);
    using work = observeSql(db, ["fts"], (sql) =>
      /\bsession_transcript_fts\b/i.test(sql) ? "fts" : null,
    );
    rewrite({ ...rewriteEvents[1], message: { ...message, content: "changed" } });
    expect(work.counts.fts).toBe(0);
    expect(sessionTranscriptIndexNeedsReconcile(db, scope.sessionId)).toBe(true);
    expect(() => readActiveTranscriptStats(scope)).toThrow(
      SessionTranscriptProjectionUnavailableError,
    );
    expect(searchSessionTranscripts({ ...scope, query: "question" }).hits).toEqual([]);
    await waitForSessionTranscriptIndexReconcile(scope);
    expect(sessionTranscriptIndexNeedsReconcile(db, scope.sessionId)).toBe(false);
    expect(searchSessionTranscripts({ ...scope, query: "changed" }).hits).toMatchObject([
      { messageId: "user" },
    ]);
    expect(readActiveTranscriptStats(scope).eventCount).toBe(3);
  });
});

it("rolls back payload-arm changes and mutation state on later conflict", async () => {
  const details = { opaque: "rollback metadata ".repeat(2048) };
  const events = detailedEvents(details);
  await withRewriteFixture(({ snapshot, scope, write }) => {
    const before = snapshot();
    const stats = readTranscriptStatsSync(scope);
    expect(() =>
      write((database) => {
        rewriteSqliteTranscriptEventRowsInTransaction(database, scope, [
          {
            seq: 1,
            expectedEventJson: JSON.stringify(events[1]),
            event: rewriteMessage(1, { content: "edited" }),
          },
          { seq: 2, expectedEventJson: JSON.stringify(events[2], null, 2), event: events[2] },
        ]);
      }),
    ).toThrow(SqliteTranscriptMutationConflictError);
    expect(snapshot()).toEqual(before);
    expect(readTranscriptStatsSync(scope)).toEqual(stats);
  }, events);
});

it.each([
  {
    name: "role",
    event: { ...rewriteEvents[1], message: { role: "toolResult", content: "question" } },
    messages: 2,
  },
  {
    name: "message presence",
    event: { type: "message", id: "user", parentId: "root" },
    messages: 1,
  },
])(
  "rebuilds changed $name facts without duplicate FTS invalidation",
  async ({ event, messages }) => {
    await withRewriteFixture(({ db, rewrite, scope }) => {
      using work = observeSql(db, ["deletes"], (sql) =>
        /^delete from ["`]?session_transcript_fts_rows["`]? /i.test(sql) ? "deletes" : null,
      );
      rewrite(event);
      const search = db
        .prepare("SELECT text, timestamp FROM session_transcript_fts ORDER BY message_id")
        .all();
      expect(search.map((row) => row.text)).toEqual(["answer"]);
      expect(
        db
          .prepare(
            "SELECT active_message_count FROM session_transcript_index_state WHERE session_id = ?",
          )
          .get(scope.sessionId)?.active_message_count,
      ).toBe(messages);
      expect(work.counts.deletes).toBeLessThanOrEqual(1);
    });
  },
);

it("avoids duplicate FTS invalidation for maintenance text repair and preserves recency", async () => {
  await withRewriteFixture(({ db, scope, snapshot }) => {
    const before = snapshot();
    const updates = [
      {
        seq: 2,
        eventJson: JSON.stringify(rewriteMessage(2, { content: "repaired answer" })),
      },
      {
        seq: 1,
        eventJson: JSON.stringify(rewriteMessage(1, { content: "repaired" })),
      },
    ] as const;
    using work = observeSql(db, ["deletes"], (sql) =>
      /^delete from ["`]?session_transcript_fts_rows["`]? /i.test(sql) ? "deletes" : null,
    );
    runOpenClawAgentWriteTransaction(
      (database) =>
        updateSqliteTranscriptEventJsonInTransaction(database, scope.sessionId, updates),
      scope,
    );
    const after = snapshot();
    expect(after.updatedAt).toBe(before.updatedAt! + 1);
    expect(after.raw).toEqual([
      before.raw[0],
      { ...before.raw[1], event_json: updates[1].eventJson },
      { ...before.raw[2], event_json: updates[0].eventJson },
    ]);
    expect(after.identities).toEqual(before.identities);
    expect(after.generation).not.toBe(before.generation);
    expect(
      db.prepare("SELECT text FROM session_transcript_fts WHERE message_id = 'user'").get()?.text,
    ).toBe("repaired");
    expect(
      db.prepare("SELECT text FROM session_transcript_fts WHERE message_id = 'answer'").get()?.text,
    ).toBe("repaired answer");
    expect(work.counts.deletes).toBeLessThanOrEqual(1);
  });
});

function readIdempotencyOwners(db: DatabaseSync, sessionId: string, ...ids: string[]) {
  return db
    .prepare(
      `SELECT event_id, message_idempotency_key FROM transcript_event_identities
     WHERE session_id = ? AND event_id IN (${ids.map(() => "?").join(",")}) ORDER BY event_id`,
    )
    .all(sessionId, ...ids);
}

function keyedAssistant(id: string, parentId: string, idempotencyKey: string, content = id) {
  return {
    type: "message",
    id,
    parentId,
    message: { role: "assistant", content, idempotencyKey },
  } as const;
}

function replaceTranscriptSuffixForTest(
  scope: { agentId: string; sessionId: string; sessionKey: string; env: NodeJS.ProcessEnv },
  expectedEvents: readonly TranscriptEvent[],
  nextEvents: readonly TranscriptEvent[],
  persistedPrefixLength = 0,
  retainedCustomDataIds: readonly string[] = [],
): void {
  runOpenClawAgentWriteTransaction((database) => {
    replaceSqliteTranscriptSuffixInTransaction(database, scope, {
      expectedEvents,
      nextEvents,
      persistedPrefixLength,
      retainedCustomDataIds,
    });
  }, scope);
}

it.each([0, 1])("preserves an intervening append before replacing prefix %i", async (prefix) => {
  await withRewriteFixture(({ snapshot, scope, write }) => {
    write((database) => {
      appendTranscriptEventInTransaction(database, scope, {
        type: "custom",
        id: "intervening",
        parentId: "answer",
      });
    });
    const before = snapshot();
    expect(() =>
      replaceTranscriptSuffixForTest(scope, rewriteEvents, rewriteEvents.slice(0, -1), prefix),
    ).toThrow(`SQLite transcript changed while preparing suffix removal for ${scope.sessionId}`);
    expect(snapshot()).toEqual(before);
  });
});

const assistant = (id: string, parentId: string | null, content: string, side = false) => ({
  type: "message",
  id,
  parentId,
  ...(side ? { appendMode: "side" } : {}),
  message: { role: "assistant", content },
});
const activeRows = (...sequences: number[]) =>
  sequences.map((event_seq) => expect.objectContaining({ event_seq }));
const searchRows = (...messages: Array<[string, string]>) =>
  messages.map(([message_id, text]) => expect.objectContaining({ message_id, text }));
const inactiveParent = assistant("inactive-parent", "root", "inactive parent", true);
const inactiveTail = assistant("inactive-tail", "inactive-parent", "inactive tail", true);
const activeChild = assistant("active-child", "answer", "active child");
const redirectedRoot = assistant("redirected-root", null, "redirected root");
const belowParent = { ...activeChild, message: { role: "user", content: "active child" } };
const siblingChild = assistant("active-child", "user", "active child");
const updatedEvents = [
  rewriteEvents[0],
  rewriteMessage(1, { content: "updated question" }),
  rewriteMessage(2, { content: "updated answer" }),
];
type SuffixCase = {
  name: string;
  events: readonly TranscriptEvent[];
  next: readonly TranscriptEvent[];
  prefix: number;
  dirty: boolean;
  active: unknown;
  search: unknown;
};
it.each`
  name                                                            | events                                                                                                           | next                                                                                                                       | prefix | dirty    | active                    | search
  ${"a suffix anchored on an inactive branch"}                    | ${[rewriteEvents[0], rewriteEvents[1], inactiveParent, inactiveTail]}                                            | ${[rewriteEvents[0], rewriteEvents[1], inactiveParent]}                                                                    | ${3}   | ${false} | ${activeRows(0, 1)}       | ${searchRows(["user", "question"])}
  ${"a later suffix redirect above the retained anchor"}          | ${[...rewriteEvents, activeChild, redirectedRoot, assistant("removed-tail", "redirected-root", "removed tail")]} | ${[...rewriteEvents, { ...activeChild, message: { role: "assistant", content: "changed active child" } }, redirectedRoot]} | ${3}   | ${true}  | ${activeRows(4)}          | ${searchRows(["redirected-root", "redirected root"])}
  ${"an inactive suffix below an active parent"}                  | ${[...rewriteEvents, assistant("inactive-child", "answer", "inactive child", true), belowParent]}                | ${[...rewriteEvents, belowParent]}                                                                                         | ${3}   | ${false} | ${activeRows(0, 1, 2, 3)} | ${expect.arrayContaining(searchRows(["active-child", "active child"]))}
  ${"an active root-level suffix exposing older durable history"} | ${[...rewriteEvents, assistant("active-root", null, "active root")]}                                             | ${rewriteEvents}                                                                                                           | ${3}   | ${true}  | ${activeRows(0, 1, 2)}    | ${expect.arrayContaining(searchRows(["user", "question"], ["answer", "answer"]))}
  ${"an inactive root-level side branch"}                         | ${[rewriteEvents[0], rewriteEvents[1], assistant("inactive-root", null, "inactive root", true), siblingChild]}   | ${[rewriteEvents[0], rewriteEvents[1], siblingChild]}                                                                      | ${2}   | ${false} | ${activeRows(0, 1, 2)}    | ${expect.arrayContaining(searchRows(["user", "question"], ["active-child", "active child"]))}
  ${"a same-length replacement after an unchanged prefix"}        | ${rewriteEvents}                                                                                                 | ${updatedEvents}                                                                                                           | ${0}   | ${false} | ${activeRows(0, 1, 2)}    | ${expect.arrayContaining(searchRows(["user", "updated question"], ["answer", "updated answer"]))}
`("reconciles $name", async ({ events, next, prefix, dirty, active, search }: SuffixCase) => {
  await withRewriteFixture(async ({ db, snapshot, scope }) => {
    await waitForSessionTranscriptIndexReconcile(scope);
    replaceTranscriptSuffixForTest(scope, events, next, prefix);
    expect(snapshot().raw).toHaveLength(next.length);
    if (prefix === 0) {
      expect(snapshot().raw).toEqual([0, 1, 2].map((seq) => expect.objectContaining({ seq })));
      expect(snapshot()).toMatchObject({ active, search });
      expect(sessionTranscriptIndexNeedsReconcile(db, scope.sessionId)).toBe(false);
    }
    if (dirty) {
      expect(sessionTranscriptIndexNeedsReconcile(db, scope.sessionId)).toBe(true);
    }
    await waitForSessionTranscriptIndexReconcile(scope);
    expect(snapshot()).toMatchObject({ active, search });
    expect(sessionTranscriptIndexNeedsReconcile(db, scope.sessionId)).toBe(false);
  }, events);
});

it("reparents a retained compressed opaque suffix while preserving payload and rollback", async () => {
  const plannedTail = {
    type: "custom",
    id: "opaque",
    parentId: "user",
    customType: "openclaw.cache-ttl",
    display: true,
    message: { role: "toolResult" },
  };
  const tail = {
    ...plannedTail,
    data: { payload: "opaque retained 🦞 ".repeat(4096) },
  };
  const events = [rewriteEvents[0], rewriteEvents[1], tail];
  const expected = [rewriteEvents[0], rewriteEvents[1], plannedTail];
  const next = [rewriteEvents[0], { ...plannedTail, parentId: "root" }];
  const retainedIds = [tail.id];
  await withRewriteFixture(({ db, snapshot, scope, write }) => {
    const before = snapshot();
    const beforeStats = readTranscriptStatsSync(scope);
    expect(before.storage[2]?.event_json).toBeNull();
    expect(before.storage[2]?.event_zstd).toBeInstanceOf(Uint8Array);
    expect(() =>
      write((database) => {
        replaceSqliteTranscriptSuffixInTransaction(database, scope, {
          expectedEvents: expected,
          nextEvents: next,
          persistedPrefixLength: 1,
          retainedCustomDataIds: retainedIds,
        });
        throw new Error("rollback retained suffix");
      }),
    ).toThrow("rollback retained suffix");
    expect(snapshot()).toEqual(before);
    expect(readTranscriptStatsSync(scope)).toEqual(beforeStats);
    replaceTranscriptSuffixForTest(scope, expected, next, 1, retainedIds);
    const result = snapshot();
    const retainedJson = JSON.stringify({ ...tail, parentId: "root" });
    expect(result.raw).toEqual([
      before.raw[0],
      { ...before.raw[2], seq: 1, event_json: retainedJson },
    ]);
    expect(result.storage[1]).toMatchObject({
      navigation_type: "custom",
      navigation_custom_type: "openclaw.cache-ttl",
      navigation_display: 1,
      message_role: "toolResult",
      navigation_last_type: "custom",
      navigation_last_custom_type: "openclaw.cache-ttl",
      navigation_valid: 1,
    });
    expect(result).toMatchObject({
      identities: [{ seq: 0 }, { seq: 1, event_id: tail.id, parent_id: "root" }],
      active: [{ event_seq: 0 }, { event_seq: 1 }],
      search: [],
    });
    expect(result.generation).not.toBe(before.generation);
    expect(readTranscriptStatsSync(scope)).toMatchObject({
      eventCount: 2,
      sizeBytes: Buffer.byteLength(`${JSON.stringify(rewriteEvents[0])}\n${retainedJson}`),
    });
    expect(sessionTranscriptIndexNeedsReconcile(db, scope.sessionId)).toBe(false);
  }, events);
});

const oldDuplicate = keyedAssistant("duplicate", "root", "old-key");
const oldOwner = keyedAssistant("owner", "duplicate", "old-key");
const newOwner = keyedAssistant("owner", "duplicate", "new-key", "updated");
const insertedOwner = keyedAssistant("new-owner", "owner", "old-key");

const owners = (...pairs: Array<[string, string | null]>) =>
  pairs.map(([event_id, message_idempotency_key]) => ({ event_id, message_idempotency_key }));
type OwnershipCase = {
  name: string;
  events: Array<{ id: string }>;
  next: Array<{ id: string }>;
  reassign: boolean;
  expectedOwners: ReturnType<typeof owners>;
};
it.each`
  name                                                                     | events                                                                                                                  | next                                                                                                   | reassign | expectedOwners
  ${"promotes a prefix duplicate when the retained owner changes its key"} | ${[rewriteEvents[0], oldDuplicate, oldOwner]}                                                                           | ${[rewriteEvents[0], oldDuplicate, newOwner]}                                                          | ${true}  | ${owners(["duplicate", "old-key"], ["owner", "new-key"])}
  ${"preserves a key claimed by an earlier suffix insert"}                 | ${[rewriteEvents[0], oldDuplicate, oldOwner, assistant("removed", "owner", "removed")]}                                 | ${[rewriteEvents[0], oldDuplicate, newOwner, insertedOwner]}                                           | ${true}  | ${owners(["duplicate", null], ["new-owner", "old-key"], ["owner", "new-key"])}
  ${"removes a retained event's key"}                                      | ${[rewriteEvents[0], keyedAssistant("owner", "root", "old-key", "original")]}                                           | ${[rewriteEvents[0], assistant("owner", "root", "updated")]}                                           | ${false} | ${owners(["owner", null])}
  ${"reserves the retained owner ahead of a new duplicate"}                | ${[rewriteEvents[0], { type: "custom", id: "removed", parentId: "root" }, keyedAssistant("owner", "removed", "retry")]} | ${[rewriteEvents[0], keyedAssistant("new", "root", "retry"), keyedAssistant("owner", "new", "retry")]} | ${false} | ${owners(["new", null], ["owner", "retry"])}
  ${"promotes a retained duplicate when its owner is removed"}             | ${[rewriteEvents[0], keyedAssistant("owner", "root", "retry"), keyedAssistant("duplicate", "owner", "retry")]}          | ${[rewriteEvents[0], keyedAssistant("duplicate", "root", "retry")]}                                    | ${false} | ${owners(["duplicate", "retry"])}
`("$name", async ({ events, next, reassign, expectedOwners }: OwnershipCase) => {
  await withRewriteFixture(({ db, scope, setKeyOwner }) => {
    if (reassign) {
      setKeyOwner("duplicate", null);
      setKeyOwner("owner", "old-key");
    }
    using work = observeSql(db, ["identityDeletes", "ownerReads"], (sql) => {
      if (/^delete from "transcript_event_identities" /i.test(sql)) {
        return "identityDeletes";
      }
      return /^select "event_id" from "transcript_event_identities" /i.test(sql) &&
        sql.includes('"message_idempotency_key" =')
        ? "ownerReads"
        : null;
    });
    replaceTranscriptSuffixForTest(scope, events, next);
    expect(work.counts).toEqual({ identityDeletes: 0, ownerReads: 0 });
    const identities = db
      .prepare(
        "SELECT event_id, seq FROM transcript_event_identities WHERE session_id = ? ORDER BY seq",
      )
      .all(scope.sessionId);
    expect(identities).toEqual(next.map((event, seq) => ({ event_id: event.id, seq })));
    expect(
      readIdempotencyOwners(db, scope.sessionId, ...expectedOwners.map((row) => row.event_id)),
    ).toEqual(expectedOwners);
  }, events);
});

it.each([
  { name: "malformed prefix", count: 2, corrupt: true, prefixKey: "retry" },
  {
    name: "duplicate beyond the rebuild bound",
    count: SYNC_REBUILD_MAX_ROWS + 1,
    corrupt: false,
    prefixKey: "\tretry\n",
  },
  {
    name: "unique key beyond the rebuild bound",
    count: SYNC_REBUILD_MAX_ROWS + 1,
    corrupt: false,
    prefixKey: undefined,
  },
])("removes the keyed suffix with a $name", async ({ count, corrupt, prefixKey }) => {
  const duplicateIndex = corrupt ? 1 : 0;
  const prefix = Array.from({ length: count }, (_, index) => ({
    type: "message" as const,
    id: `prefix-${index}`,
    parentId: index === 0 ? "root" : `prefix-${index - 1}`,
    message: {
      role: "assistant" as const,
      content: `prefix ${index}`,
      ...(index === duplicateIndex && prefixKey ? { idempotencyKey: prefixKey } : {}),
    },
  }));
  const owner = keyedAssistant("owner", prefix.at(-1)!.id, prefixKey ? "retry" : "unique");
  const events = [rewriteEvents[0], ...prefix, owner];
  const duplicateId = prefix[duplicateIndex]!.id;
  await withRewriteFixture(({ db, scope, setKeyOwner }) => {
    if (prefixKey) {
      setKeyOwner(duplicateId, null);
      setKeyOwner(owner.id, "retry");
    }
    if (corrupt) {
      db.prepare(
        "UPDATE transcript_events SET event_json = ? WHERE session_id = ? AND seq = 1",
      ).run("{", scope.sessionId);
    }
    replaceTranscriptSuffixForTest(scope, events, events.slice(0, -1), events.length - 1);
    if (prefixKey) {
      expect(readIdempotencyOwners(db, scope.sessionId, duplicateId)).toEqual([
        { event_id: duplicateId, message_idempotency_key: "retry" },
      ]);
    } else {
      expect(
        db
          .prepare(
            "SELECT event_id FROM transcript_event_identities WHERE session_id = ? AND event_id = ?",
          )
          .get(scope.sessionId, owner.id),
      ).toBeUndefined();
    }
  }, events);
});

it("preserves retained row timestamps when an already-dirty projection needs reconciliation", async () => {
  await withRewriteFixture(async ({ db, snapshot, scope }) => {
    db.prepare(
      "UPDATE transcript_events SET created_at = 303 WHERE session_id = ? AND seq = 2",
    ).run(scope.sessionId);
    db.prepare(
      "UPDATE transcript_event_identities SET created_at = 303 WHERE session_id = ? AND event_id = ?",
    ).run(scope.sessionId, "answer");
    db.prepare(
      "UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?",
    ).run(scope.sessionId);
    const generation = snapshot().generation;
    const retainedAnswer = { ...rewriteEvents[2], parentId: "root" };

    replaceTranscriptSuffixForTest(scope, rewriteEvents, [rewriteEvents[0], retainedAnswer], 1);

    const rotatedGeneration = snapshot().generation;
    expect(rotatedGeneration).not.toBe(generation);
    expect(snapshot().raw).toMatchObject([{ seq: 0 }, { created_at: 303, seq: 1 }]);
    await waitForSessionTranscriptIndexReconcile(scope);
    expect(snapshot().generation).toBe(rotatedGeneration);
    expect(sessionTranscriptIndexNeedsReconcile(db, scope.sessionId)).toBe(false);
    expect(snapshot().identities).toMatchObject([
      { seq: 0 },
      { created_at: 303, event_id: "answer", seq: 1 },
    ]);
  });
});
