import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { cleanupTempDirs, makeTempDir } from "../../../test/helpers/temp-dir.js";
import { clearNodeSqliteKyselyCacheForDatabase } from "../../infra/kysely-sync.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { readSessionTranscriptActiveStats } from "./session-accessor.sqlite-active-events.js";
import type { TranscriptEvent } from "./session-accessor.sqlite-contract.js";
import {
  readTranscriptEventRows,
  readTranscriptStatsSync,
  readTranscriptStorageRows,
} from "./session-accessor.sqlite-read.js";
import {
  readTranscriptGenerationInTransaction,
  readTranscriptMutationStateInTransaction,
} from "./session-accessor.sqlite-transcript-state.js";
import {
  appendTranscriptEventInTransaction,
  appendTranscriptEventsInTransaction,
  rewriteSqliteTranscriptEventRowsInTransaction,
  updateSqliteTranscriptEventJsonInTransaction,
} from "./session-accessor.sqlite-transcript-store.js";
import {
  prepareSqliteTranscriptSuffixMutation,
  replaceSqliteTranscriptSuffixInTransaction,
} from "./session-accessor.sqlite-transcript-suffix.js";
import {
  SYNC_REBUILD_MAX_BYTES,
  SYNC_REBUILD_MAX_ROWS,
  sessionTranscriptIndexNeedsReconcile,
} from "./session-transcript-index.js";
import { SessionTranscriptProjectionUnavailableError } from "./session-transcript-projection-error.js";
import {
  appendPreparedSessionTranscriptProjectionChunkInTransaction,
  finalizePreparedSessionTranscriptProjectionInTransaction,
  prepareSessionTranscriptProjection,
  claimPreparedSessionTranscriptProjectionInTransaction,
} from "./session-transcript-projection-rebuild.js";
import { waitForSessionTranscriptIndexReconcile } from "./session-transcript-reconcile.js";
import { searchSessionTranscriptsReadOnlySync as searchSessionTranscripts } from "./session-transcript-search.js";

const tempDirs: string[] = [];

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  cleanupTempDirs(tempDirs);
});

describe("SQLite transcript append", () => {
  it("canonicalizes assistant media at the generic transcript append owner", async () => {
    const stateDir = makeTempDir(tempDirs, "media-persistence-append-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const committedJson = runOpenClawAgentWriteTransaction(
      (database) =>
        appendTranscriptEventInTransaction(
          database,
          {
            agentId: "main",
            env,
            sessionId: "append-session",
            sessionKey: "agent:main:append-session",
          },
          {
            type: "message",
            id: "event-1",
            parentId: null,
            timestamp: 1000,
            message: {
              role: "assistant",
              content: "append",
              MediaPaths: ["/media/a.png"],
              MediaTypes: ["image/png"],
            },
          },
        ),
      { agentId: "main", env },
    );
    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    const row = database.db
      .prepare("SELECT event_json FROM transcript_events WHERE session_id = ? AND seq = 0")
      .get("append-session") as { event_json: string };
    expect(committedJson).toBe(row.event_json);
    const message = (JSON.parse(row.event_json) as { message: Record<string, unknown> }).message;
    expect(message).toMatchObject({ role: "assistant", content: "append" });
    expect(message).not.toHaveProperty("MediaPaths");
    expect(message).not.toHaveProperty("MediaTypes");
    expect(message["__openclaw"]).toMatchObject({
      media: [expect.objectContaining({ path: "/media/a.png", contentType: "image/png" })],
    });

    const generation = readTranscriptGenerationInTransaction(database, "append-session");
    const next = {
      type: "message",
      id: "event-2",
      parentId: "event-1",
      timestamp: 1001,
      message: { role: "assistant", content: "next" },
    };
    const policy = trackSqliteStatementExecutions(database.db, ["policy"], (sql) =>
      sql.includes('"session_key_contract"') ? "policy" : null,
    );
    let nextJson: string | false;
    try {
      nextJson = runOpenClawAgentWriteTransaction(
        (writer) =>
          appendTranscriptEventInTransaction(
            writer,
            {
              agentId: "main",
              env,
              sessionId: "append-session",
              sessionKey: "agent:main:append-session",
            },
            next,
          ),
        { agentId: "main", env },
      );
    } finally {
      policy.restore();
    }
    expect(nextJson).toBe(JSON.stringify(next));
    expect(
      database.db
        .prepare("SELECT seq, event_json FROM transcript_events WHERE session_id = ? ORDER BY seq")
        .all("append-session"),
    ).toEqual([
      { seq: 0, event_json: committedJson },
      { seq: 1, event_json: nextJson },
    ]);
    expect(readTranscriptGenerationInTransaction(database, "append-session")).toBe(generation);
    expect(policy.counts).toEqual({ policy: 1 });
    expect(policy.rowCounts).toEqual({ policy: 1 });
    expect(policy.textBytes).toEqual({ policy: 4 });
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

async function withRewriteFixture(
  run: (f: {
    db: DatabaseSync;
    snapshot: () => {
      raw: Array<Record<string, unknown>>;
      storage: Array<Record<string, unknown>>;
      identities: unknown[];
      active: unknown[];
      search: unknown[];
      generation: string | undefined;
      updatedAt: number | null;
    };
    rewrite: (event: unknown, seq?: number) => void;
    scope: { agentId: string; sessionId: string; sessionKey: string; env: NodeJS.ProcessEnv };
  }) => void | Promise<void>,
  events: readonly unknown[] = rewriteEvents,
) {
  await withOpenClawTestState({ label: "exact-rewrite" }, async (state) => {
    const scope = {
      agentId: "main",
      sessionId: "rewrite",
      sessionKey: "agent:main:rewrite",
      env: state.env,
    };
    const owner = openOpenClawAgentDatabase(scope);
    const { db } = owner;
    runOpenClawAgentWriteTransaction((database) => {
      appendTranscriptEventsInTransaction(database, scope, events);
    }, scope);
    const snapshot = () => ({
      raw: readTranscriptStorageRows(owner, scope.sessionId).map((row) => ({
        session_id: scope.sessionId,
        seq: row.seq,
        event_json: row.eventJson,
        created_at: row.createdAt,
      })),
      storage: db
        .prepare("SELECT * FROM transcript_events WHERE session_id = ? ORDER BY seq")
        .all(scope.sessionId),
      identities: db
        .prepare("SELECT * FROM transcript_event_identities WHERE session_id = ? ORDER BY seq")
        .all(scope.sessionId),
      active: db
        .prepare(
          "SELECT * FROM session_transcript_active_events WHERE session_id = ? ORDER BY active_position",
        )
        .all(scope.sessionId),
      search: db
        .prepare("SELECT * FROM session_transcript_fts WHERE session_id = ? ORDER BY message_id")
        .all(scope.sessionId),
      generation: readTranscriptGenerationInTransaction(owner, scope.sessionId),
      updatedAt: readTranscriptMutationStateInTransaction(owner, scope.sessionId).updatedAt,
    });
    const rewrite = (event: unknown, seq = 1) => {
      const row = readTranscriptEventRows(owner, scope.sessionId).find(
        (entry) => entry.seq === seq,
      );
      if (!row) {
        throw new Error("missing rewrite row");
      }
      const expectedEventJson = row.eventJson;
      runOpenClawAgentWriteTransaction((database) => {
        rewriteSqliteTranscriptEventRowsInTransaction(database, scope, [
          { seq, event, expectedEventJson },
        ]);
      }, scope);
    };
    await run({ db, snapshot, rewrite, scope });
  });
}

describe("SQLite exact transcript rewrite", () => {
  it("applies exact bindings across both storage arms", async () => {
    const details = { opaque: "preserved metadata ".repeat(2048) };
    const events = [
      rewriteEvents[0],
      {
        ...rewriteEvents[1],
        message: { ...rewriteEvents[1].message, details },
      },
      {
        ...rewriteEvents[2],
        message: { ...rewriteEvents[2].message, details },
      },
    ];
    await withRewriteFixture(({ snapshot, scope }) => {
      const before = snapshot();
      const first = {
        ...rewriteEvents[2],
        message: {
          ...rewriteEvents[2].message,
          provenance: "first",
        },
      };
      const last = {
        ...rewriteEvents[2],
        message: {
          ...rewriteEvents[2].message,
          provenance: "last",
          details,
        },
      };
      const user = {
        ...rewriteEvents[1],
        message: {
          ...rewriteEvents[1].message,
          provenance: "user",
        },
      };
      expect(before.storage[1]?.event_json === null).toBe(true);
      expect(before.storage[2]?.event_zstd instanceof Uint8Array).toBe(true);
      const work = trackSqliteStatementExecutions(
        openOpenClawAgentDatabase(scope).db,
        ["fts", "size"],
        (sql) =>
          /\bsession_transcript_fts\b/i.test(sql)
            ? "fts"
            : sql.includes('from "transcript_events"') && sql.includes("octet_length")
              ? "size"
              : null,
      );
      try {
        runOpenClawAgentWriteTransaction((database) => {
          rewriteSqliteTranscriptEventRowsInTransaction(database, scope, [
            { seq: 2, expectedEventJson: JSON.stringify(events[2]), event: first },
            { seq: 1, expectedEventJson: JSON.stringify(events[1]), event: user },
            { seq: 2, expectedEventJson: JSON.stringify(first), event: last },
          ]);
        }, scope);
      } finally {
        work.restore();
      }
      expect(work.counts).toEqual({ fts: 0, size: 0 });
      const after = snapshot();
      expect(after.raw).toEqual([
        before.raw[0],
        { ...before.raw[1], event_json: JSON.stringify(user) },
        { ...before.raw[2], event_json: JSON.stringify(last) },
      ]);
      expect(after.identities).toEqual(before.identities);
      expect(after.active).toEqual(before.active);
      expect(after.search).toEqual(before.search);
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
      const before = prepareSessionTranscriptProjection(db, scope.sessionId)!;
      const work = trackSqliteStatementExecutions(db, ["fts"], (sql) =>
        /\bsession_transcript_fts\b/i.test(sql) ? "fts" : null,
      );
      try {
        rewrite({ ...rewriteEvents[1], message: { ...message, content: "changed" } });
        expect(work.counts.fts).toBe(0);
      } finally {
        work.restore();
      }
      expect(sessionTranscriptIndexNeedsReconcile(db, scope.sessionId)).toBe(true);
      expect(() => readSessionTranscriptActiveStats(scope)).toThrow(
        SessionTranscriptProjectionUnavailableError,
      );
      expect(searchSessionTranscripts({ ...scope, query: "question" }).hits).toEqual([]);
      expect(claimPreparedSessionTranscriptProjectionInTransaction(db, before, -1)).toBe(false);
      await waitForSessionTranscriptIndexReconcile(scope);
      expect(sessionTranscriptIndexNeedsReconcile(db, scope.sessionId)).toBe(false);
      expect(searchSessionTranscripts({ ...scope, query: "changed" }).hits).toMatchObject([
        { messageId: "user" },
      ]);
      expect(readSessionTranscriptActiveStats(scope).eventCount).toBe(3);
    });
  });

  it("rolls back payload-arm changes and mutation state on later conflict", async () => {
    const details = { opaque: "rollback metadata ".repeat(2048) };
    const events = [
      rewriteEvents[0],
      {
        ...rewriteEvents[1],
        message: { ...rewriteEvents[1].message, details },
      },
      {
        ...rewriteEvents[2],
        message: { ...rewriteEvents[2].message, details },
      },
    ];
    await withRewriteFixture(({ snapshot, scope }) => {
      const before = snapshot();
      const stats = readTranscriptStatsSync(scope);
      expect(() =>
        runOpenClawAgentWriteTransaction((database) => {
          rewriteSqliteTranscriptEventRowsInTransaction(database, scope, [
            {
              seq: 1,
              expectedEventJson: JSON.stringify(events[1]),
              event: {
                ...rewriteEvents[1],
                message: { role: "user", content: "edited" },
              },
            },
            { seq: 2, expectedEventJson: JSON.stringify(events[2], null, 2), event: events[2] },
          ]);
        }, scope),
      ).toThrow("changed before exact rewrite");
      expect(snapshot()).toEqual(before);
      expect(readTranscriptStatsSync(scope)).toEqual(stats);
    }, events);
  });

  it("recovers a claimed projection on metadata rewrite and fences stale publication", async () => {
    await withRewriteFixture(({ db, rewrite, snapshot, scope }) => {
      const before = snapshot();
      const plan = prepareSessionTranscriptProjection(db, scope.sessionId)!;
      db.prepare("UPDATE session_transcript_index_state SET needs_rebuild = 1").run();
      expect(claimPreparedSessionTranscriptProjectionInTransaction(db, plan, -1)).toBe(true);
      db.prepare("DELETE FROM session_transcript_active_events").run();
      db.prepare("DELETE FROM session_transcript_fts_rows").run();
      expect(sessionTranscriptIndexNeedsReconcile(db, scope.sessionId)).toBe(true);
      rewrite({ ...rewriteEvents[1], message: { ...rewriteEvents[1].message, provenance: "new" } });
      expect(sessionTranscriptIndexNeedsReconcile(db, scope.sessionId)).toBe(false);
      expect(snapshot().active).toEqual(before.active);
      expect(snapshot().search).toEqual(before.search);
      expect(claimPreparedSessionTranscriptProjectionInTransaction(db, plan, -2)).toBe(false);
      expect(
        appendPreparedSessionTranscriptProjectionChunkInTransaction(db, {
          sessionId: scope.sessionId,
          claimId: -1,
          ftsRows: plan.ftsRows,
        }),
      ).toBe(false);
      expect(finalizePreparedSessionTranscriptProjectionInTransaction(db, plan, -1)).toBe(false);
    });
  });

  it.each([
    {
      name: "role",
      seq: 1,
      event: { ...rewriteEvents[1], message: { role: "toolResult", content: "question" } },
      texts: ["answer"],
      messages: 2,
    },
    {
      name: "message presence",
      seq: 1,
      event: { type: "message", id: "user", parentId: "root" },
      texts: ["answer"],
      messages: 1,
    },
  ])(
    "rebuilds changed $name facts without duplicate FTS invalidation",
    async ({ event, seq, texts, messages }) => {
      await withRewriteFixture(({ db, rewrite, scope }) => {
        const work = trackSqliteStatementExecutions(db, ["deletes"], (sql) =>
          /^delete from ["`]?session_transcript_fts_rows["`]? /i.test(sql) ? "deletes" : null,
        );
        try {
          rewrite(event, seq);
        } finally {
          work.restore();
        }
        const search = db
          .prepare("SELECT text, timestamp FROM session_transcript_fts ORDER BY message_id")
          .all();
        expect(search.map((row) => row.text)).toEqual(texts);
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
          eventJson: JSON.stringify({
            ...rewriteEvents[2],
            message: { role: "assistant", content: "repaired answer" },
          }),
        },
        {
          seq: 1,
          eventJson: JSON.stringify({
            ...rewriteEvents[1],
            message: { role: "user", content: "repaired" },
          }),
        },
      ] as const;
      const work = trackSqliteStatementExecutions(db, ["deletes"], (sql) =>
        /^delete from ["`]?session_transcript_fts_rows["`]? /i.test(sql) ? "deletes" : null,
      );
      try {
        runOpenClawAgentWriteTransaction(
          (database) =>
            updateSqliteTranscriptEventJsonInTransaction(database, scope.sessionId, updates),
          scope,
        );
      } finally {
        work.restore();
      }
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
        db.prepare("SELECT text FROM session_transcript_fts WHERE message_id = 'answer'").get()
          ?.text,
      ).toBe("repaired answer");
      expect(work.counts.deletes).toBeLessThanOrEqual(1);
    });
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
  const owner = openOpenClawAgentDatabase(scope);
  const plan = prepareSqliteTranscriptSuffixMutation(
    owner,
    scope,
    expectedEvents,
    nextEvents,
    persistedPrefixLength,
    undefined,
    false,
    retainedCustomDataIds,
  );
  runOpenClawAgentWriteTransaction((database) => {
    replaceSqliteTranscriptSuffixInTransaction(database, scope, plan);
  }, scope);
}

describe("SQLite exact transcript suffix replacement", () => {
  it("rejects a changed mutation fence while planning an incremental suffix", async () => {
    await withRewriteFixture(({ db, scope }) => {
      clearNodeSqliteKyselyCacheForDatabase(db);
      const originalPrepare = db.prepare.bind(db);
      let changedFence = false;
      const prepareSpy = vi.spyOn(db, "prepare").mockImplementation((sqlText: string) => {
        if (
          !changedFence &&
          sqlText.toLowerCase().includes("session_transcript_active_events") &&
          sqlText.toLowerCase().includes("event_seq")
        ) {
          originalPrepare(
            `UPDATE session_windows
             SET transcript_updated_at = transcript_updated_at + 1
             WHERE session_id = ?`,
          ).run(scope.sessionId);
          changedFence = true;
        }
        return originalPrepare(sqlText);
      });
      try {
        expect(() =>
          prepareSqliteTranscriptSuffixMutation(
            openOpenClawAgentDatabase(scope),
            scope,
            rewriteEvents,
            rewriteEvents.slice(0, -1),
            rewriteEvents.length - 1,
          ),
        ).toThrow(`SQLite transcript changed while planning suffix removal for ${scope.sessionId}`);
      } finally {
        prepareSpy.mockRestore();
      }
      expect(changedFence).toBe(true);
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
  it.each([
    {
      name: "a suffix anchored on an inactive branch",
      events: [rewriteEvents[0], rewriteEvents[1], inactiveParent, inactiveTail],
      next: [rewriteEvents[0], rewriteEvents[1], inactiveParent],
      prefix: 3,
      dirty: false,
      active: activeRows(0, 1),
      search: searchRows(["user", "question"]),
    },
    {
      name: "a later suffix redirect above the retained anchor",
      events: [
        ...rewriteEvents,
        activeChild,
        redirectedRoot,
        assistant("removed-tail", "redirected-root", "removed tail"),
      ],
      next: [
        ...rewriteEvents,
        { ...activeChild, message: { role: "assistant", content: "changed active child" } },
        redirectedRoot,
      ],
      prefix: 3,
      dirty: true,
      active: activeRows(4),
      search: searchRows(["redirected-root", "redirected root"]),
    },
    {
      name: "an inactive suffix below an active parent",
      events: [
        ...rewriteEvents,
        assistant("inactive-child", "answer", "inactive child", true),
        belowParent,
      ],
      next: [...rewriteEvents, belowParent],
      prefix: 3,
      dirty: false,
      active: activeRows(0, 1, 2, 3),
      search: expect.arrayContaining(searchRows(["active-child", "active child"])),
    },
    {
      name: "an active root-level suffix exposing older durable history",
      events: [...rewriteEvents, assistant("active-root", null, "active root")],
      next: rewriteEvents,
      prefix: 3,
      dirty: true,
      active: activeRows(0, 1, 2),
      search: expect.arrayContaining(searchRows(["user", "question"], ["answer", "answer"])),
    },
    {
      name: "an inactive root-level side branch",
      events: [
        rewriteEvents[0],
        rewriteEvents[1],
        assistant("inactive-root", null, "inactive root", true),
        siblingChild,
      ],
      next: [rewriteEvents[0], rewriteEvents[1], siblingChild],
      prefix: 2,
      dirty: false,
      active: activeRows(0, 1, 2),
      search: expect.arrayContaining(
        searchRows(["user", "question"], ["active-child", "active child"]),
      ),
    },
  ])("reconciles $name", async ({ events, next, prefix, dirty, active, search }) => {
    await withRewriteFixture(async ({ db, snapshot, scope }) => {
      await waitForSessionTranscriptIndexReconcile(scope);
      replaceTranscriptSuffixForTest(scope, events, next, prefix);
      expect(snapshot().raw).toHaveLength(next.length);
      if (dirty) {
        expect(sessionTranscriptIndexNeedsReconcile(db, scope.sessionId)).toBe(true);
      }
      await waitForSessionTranscriptIndexReconcile(scope);
      expect(snapshot()).toMatchObject({ active, search });
      expect(sessionTranscriptIndexNeedsReconcile(db, scope.sessionId)).toBe(false);
    }, events);
  });

  it("reparents a retained compressed opaque suffix while preserving payload and rollback", async () => {
    const tail = {
      type: "custom",
      id: "opaque",
      parentId: "user",
      data: { payload: "opaque retained 🦞 ".repeat(4096) },
    };
    const events = [rewriteEvents[0], rewriteEvents[1], tail];
    const plannedTail = { type: "custom", id: "opaque", parentId: "user" };
    const expected = [rewriteEvents[0], rewriteEvents[1], plannedTail];
    const next = [rewriteEvents[0], { ...plannedTail, parentId: "root" }];
    const retainedIds = [tail.id];
    await withRewriteFixture(({ db, snapshot, scope }) => {
      const before = snapshot();
      const beforeStats = readTranscriptStatsSync(scope);
      expect(before.storage[2]?.event_json).toBeNull();
      expect(before.storage[2]?.event_zstd).toBeInstanceOf(Uint8Array);
      const plan = prepareSqliteTranscriptSuffixMutation(
        openOpenClawAgentDatabase(scope),
        scope,
        expected,
        next,
        1,
        undefined,
        false,
        retainedIds,
      );
      expect(() =>
        runOpenClawAgentWriteTransaction((database) => {
          replaceSqliteTranscriptSuffixInTransaction(database, scope, plan);
          throw new Error("rollback retained suffix");
        }, scope),
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
      expect(result).toMatchObject({
        identities: [
          expect.objectContaining({ seq: 0 }),
          expect.objectContaining({ seq: 1, event_id: tail.id, parent_id: "root" }),
        ],
        active: [
          expect.objectContaining({ event_seq: 0 }),
          expect.objectContaining({ event_seq: 1 }),
        ],
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

  it("validates only the unchanged projection prefix for same-length suffix replacement", async () => {
    await withRewriteFixture(({ db, snapshot, scope }) => {
      const replacementEvents = [
        rewriteEvents[0],
        { ...rewriteEvents[1], message: { role: "user", content: "updated question" } },
        { ...rewriteEvents[2], message: { role: "assistant", content: "updated answer" } },
      ] as const;

      replaceTranscriptSuffixForTest(scope, rewriteEvents, replacementEvents);

      const result = snapshot();
      expect(result).toMatchObject({
        raw: [
          expect.objectContaining({ seq: 0 }),
          expect.objectContaining({ seq: 1 }),
          expect.objectContaining({ seq: 2 }),
        ],
        active: [
          expect.objectContaining({ event_seq: 0 }),
          expect.objectContaining({ event_seq: 1 }),
          expect.objectContaining({ event_seq: 2 }),
        ],
      });
      expect(result.search).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ message_id: "user", text: "updated question" }),
          expect.objectContaining({ message_id: "answer", text: "updated answer" }),
        ]),
      );
      expect(sessionTranscriptIndexNeedsReconcile(db, scope.sessionId)).toBe(false);
    });
  });

  it("promotes an unchanged-prefix duplicate when a retained event changes its key", async () => {
    const originalEvents = [
      rewriteEvents[0],
      keyedAssistant("duplicate", "root", "old-key"),
      keyedAssistant("owner", "duplicate", "old-key"),
    ] as const;
    await withRewriteFixture(({ db, scope }) => {
      db.prepare(
        "UPDATE transcript_event_identities SET message_idempotency_key = NULL WHERE session_id = ? AND event_id = ?",
      ).run(scope.sessionId, "duplicate");
      db.prepare(
        "UPDATE transcript_event_identities SET message_idempotency_key = ? WHERE session_id = ? AND event_id = ?",
      ).run("old-key", scope.sessionId, "owner");
      const replacementEvents = [
        originalEvents[0],
        originalEvents[1],
        {
          ...originalEvents[2],
          message: { role: "assistant", content: "updated", idempotencyKey: "new-key" },
        },
      ] as const;

      replaceTranscriptSuffixForTest(scope, originalEvents, replacementEvents);

      expect(readIdempotencyOwners(db, scope.sessionId, "duplicate", "owner")).toEqual([
        { event_id: "duplicate", message_idempotency_key: "old-key" },
        { event_id: "owner", message_idempotency_key: "new-key" },
      ]);
    }, originalEvents);
  });

  it("removes the idempotency owner when a retained event removes its key", async () => {
    const originalEvents = [
      rewriteEvents[0],
      keyedAssistant("owner", "root", "old-key", "original"),
    ] as const;
    await withRewriteFixture(({ db, scope }) => {
      const replacementEvents = [
        originalEvents[0],
        {
          ...originalEvents[1],
          message: { role: "assistant", content: "updated" },
        },
      ] as const;

      replaceTranscriptSuffixForTest(scope, originalEvents, replacementEvents);

      expect(readIdempotencyOwners(db, scope.sessionId, "owner")).toEqual([
        { event_id: "owner", message_idempotency_key: null },
      ]);
    }, originalEvents);
  });

  it("preserves the established idempotency owner across retained suffix rows", async () => {
    const duplicateKeyEvents = [
      rewriteEvents[0],
      keyedAssistant("first", "root", "retry"),
      { type: "custom", id: "removed", parentId: "first" },
      keyedAssistant("owner", "removed", "retry"),
    ] as const;
    await withRewriteFixture(({ db, scope }) => {
      db.prepare(
        "UPDATE transcript_events SET created_at = CASE seq WHEN 1 THEN 101 WHEN 3 THEN 303 ELSE created_at END WHERE session_id = ?",
      ).run(scope.sessionId);
      db.prepare(
        "UPDATE transcript_event_identities SET message_idempotency_key = NULL, created_at = 101 WHERE session_id = ? AND event_id = ?",
      ).run(scope.sessionId, "first");
      db.prepare(
        "UPDATE transcript_event_identities SET message_idempotency_key = ?, created_at = 303 WHERE session_id = ? AND event_id = ?",
      ).run("retry", scope.sessionId, "owner");

      replaceTranscriptSuffixForTest(scope, duplicateKeyEvents, [
        duplicateKeyEvents[0],
        duplicateKeyEvents[1],
        { ...duplicateKeyEvents[3], parentId: "first" },
      ]);

      expect(
        db
          .prepare(
            "SELECT event_id, message_idempotency_key, created_at FROM transcript_event_identities WHERE session_id = ? AND event_id IN ('first', 'owner') ORDER BY event_id",
          )
          .all(scope.sessionId),
      ).toEqual([
        { event_id: "first", message_idempotency_key: null, created_at: 101 },
        { event_id: "owner", message_idempotency_key: "retry", created_at: 303 },
      ]);
      expect(
        db
          .prepare(
            "SELECT seq, created_at FROM transcript_events WHERE session_id = ? AND seq IN (1, 2) ORDER BY seq",
          )
          .all(scope.sessionId),
      ).toEqual([
        { seq: 1, created_at: 101 },
        { seq: 2, created_at: 303 },
      ]);
    }, duplicateKeyEvents);
  });

  it("reserves a retained idempotency owner when a new duplicate precedes it", async () => {
    const duplicateKeyEvents = [
      rewriteEvents[0],
      { type: "custom", id: "removed", parentId: "root" },
      keyedAssistant("owner", "removed", "retry"),
    ] as const;
    await withRewriteFixture(({ db, scope }) => {
      replaceTranscriptSuffixForTest(scope, duplicateKeyEvents, [
        duplicateKeyEvents[0],
        keyedAssistant("new", "root", "retry"),
        { ...duplicateKeyEvents[2], parentId: "new" },
      ]);

      expect(readIdempotencyOwners(db, scope.sessionId, "new", "owner")).toEqual([
        { event_id: "new", message_idempotency_key: null },
        { event_id: "owner", message_idempotency_key: "retry" },
      ]);
    }, duplicateKeyEvents);
  });

  it("promotes a retained duplicate when its prior idempotency owner is removed", async () => {
    const duplicateKeyEvents = [
      rewriteEvents[0],
      keyedAssistant("owner", "root", "retry"),
      keyedAssistant("duplicate", "owner", "retry"),
    ] as const;
    await withRewriteFixture(({ db, scope }) => {
      replaceTranscriptSuffixForTest(scope, duplicateKeyEvents, [
        duplicateKeyEvents[0],
        { ...duplicateKeyEvents[2], parentId: "root" },
      ]);

      expect(readIdempotencyOwners(db, scope.sessionId, "duplicate")).toEqual([
        { event_id: "duplicate", message_idempotency_key: "retry" },
      ]);
    }, duplicateKeyEvents);
  });

  it("skips malformed unchanged-prefix rows while promoting an idempotency owner", async () => {
    const duplicateKeyEvents = [
      rewriteEvents[0],
      assistant("corrupt-prefix", "root", "corrupt"),
      keyedAssistant("duplicate", "corrupt-prefix", "retry"),
      keyedAssistant("owner", "duplicate", "retry"),
    ] as const;
    await withRewriteFixture(({ db, scope }) => {
      db.prepare(
        "UPDATE transcript_event_identities SET message_idempotency_key = NULL WHERE session_id = ? AND event_id = ?",
      ).run(scope.sessionId, "duplicate");
      db.prepare(
        "UPDATE transcript_event_identities SET message_idempotency_key = ? WHERE session_id = ? AND event_id = ?",
      ).run("retry", scope.sessionId, "owner");
      db.prepare(
        `UPDATE transcript_events
         SET event_json = ?
         WHERE session_id = ?
           AND seq = (
             SELECT seq
             FROM transcript_event_identities
             WHERE session_id = ? AND event_id = ?
           )`,
      ).run("{", scope.sessionId, scope.sessionId, "corrupt-prefix");

      replaceTranscriptSuffixForTest(scope, duplicateKeyEvents, duplicateKeyEvents.slice(0, -1), 3);

      expect(readIdempotencyOwners(db, scope.sessionId, "duplicate")).toEqual([
        { event_id: "duplicate", message_idempotency_key: "retry" },
      ]);
    }, duplicateKeyEvents);
  });

  it("promotes an idempotency owner beyond the projection rebuild row bound", async () => {
    const prefix = Array.from({ length: SYNC_REBUILD_MAX_ROWS + 1 }, (_value, index) => ({
      type: "message" as const,
      id: `keyed-prefix-${index}`,
      parentId: index === 0 ? "root" : `keyed-prefix-${index - 1}`,
      message: {
        role: "assistant" as const,
        content: `prefix ${index}`,
        ...(index === 0 ? { idempotencyKey: "\tretry\n" } : {}),
      },
    }));
    const owner = {
      type: "message" as const,
      id: "keyed-suffix-owner",
      parentId: prefix.at(-1)?.id ?? "root",
      message: { role: "assistant" as const, content: "owner", idempotencyKey: "retry" },
    };
    const duplicateKeyEvents = [rewriteEvents[0], ...prefix, owner];
    const duplicateId = prefix[0]!.id;
    await withRewriteFixture(({ db, scope }) => {
      db.prepare(
        "UPDATE transcript_event_identities SET message_idempotency_key = NULL WHERE session_id = ? AND event_id = ?",
      ).run(scope.sessionId, duplicateId);
      db.prepare(
        "UPDATE transcript_event_identities SET message_idempotency_key = ? WHERE session_id = ? AND event_id = ?",
      ).run("retry", scope.sessionId, owner.id);
      replaceTranscriptSuffixForTest(
        scope,
        duplicateKeyEvents,
        duplicateKeyEvents.slice(0, -1),
        duplicateKeyEvents.length - 1,
      );
      expect(readIdempotencyOwners(db, scope.sessionId, duplicateId)).toEqual([
        { event_id: duplicateId, message_idempotency_key: "retry" },
      ]);
    }, duplicateKeyEvents);
  });

  it("removes a unique keyed suffix beyond the projection rebuild row bound", async () => {
    const prefix = Array.from({ length: SYNC_REBUILD_MAX_ROWS + 1 }, (_value, index) => ({
      type: "message" as const,
      id: `unique-prefix-${index}`,
      parentId: index === 0 ? "root" : `unique-prefix-${index - 1}`,
      message: { role: "assistant" as const, content: `prefix ${index}` },
    }));
    const owner = {
      type: "message" as const,
      id: "unique-suffix-owner",
      parentId: prefix.at(-1)?.id ?? "root",
      message: { role: "assistant" as const, content: "owner", idempotencyKey: "unique" },
    };
    const events = [rewriteEvents[0], ...prefix, owner];
    await withRewriteFixture(({ db, scope }) => {
      replaceTranscriptSuffixForTest(scope, events, events.slice(0, -1), events.length - 1);

      expect(
        db
          .prepare(
            "SELECT event_id FROM transcript_event_identities WHERE session_id = ? AND event_id = ?",
          )
          .get(scope.sessionId, owner.id),
      ).toBeUndefined();
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
      expect(snapshot().raw).toEqual([
        expect.objectContaining({ seq: 0 }),
        expect.objectContaining({ created_at: 303, seq: 1 }),
      ]);
      await waitForSessionTranscriptIndexReconcile(scope);
      expect(snapshot().generation).toBe(rotatedGeneration);
      expect(sessionTranscriptIndexNeedsReconcile(db, scope.sessionId)).toBe(false);
      expect(snapshot().identities).toEqual([
        expect.objectContaining({ seq: 0 }),
        expect.objectContaining({ created_at: 303, event_id: "answer", seq: 1 }),
      ]);
    });
  });
});
