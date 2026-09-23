import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { cleanupTempDirs, makeTempDir } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { readSessionTranscriptActiveStats } from "./session-accessor.sqlite-active-events.js";
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
  SYNC_REBUILD_MAX_BYTES,
  sessionTranscriptIndexNeedsReconcile,
} from "./session-transcript-index.js";
import { SessionTranscriptProjectionUnavailableError } from "./session-transcript-projection-error.js";
import {
  prepareSessionTranscriptProjection,
  claimPreparedSessionTranscriptProjectionInTransaction,
  finalizePreparedSessionTranscriptProjectionInTransaction,
  appendPreparedSessionTranscriptProjectionChunkInTransaction,
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
  it.each([false, true])(
    "applies exact bindings across both storage arms, initially compressed=%s",
    async (compressed) => {
      const details = { opaque: "preserved metadata ".repeat(2048) };
      const events = [
        rewriteEvents[0],
        {
          ...rewriteEvents[1],
          message: { ...rewriteEvents[1].message, ...(compressed ? { details } : {}) },
        },
        {
          ...rewriteEvents[2],
          message: { ...rewriteEvents[2].message, ...(compressed ? { details } : {}) },
        },
      ];
      await withRewriteFixture(({ snapshot, scope }) => {
        const before = snapshot();
        const first = {
          ...rewriteEvents[2],
          message: {
            ...rewriteEvents[2].message,
            provenance: "first",
            ...(!compressed ? { details } : {}),
          },
        };
        const last = {
          ...rewriteEvents[2],
          message: {
            ...rewriteEvents[2].message,
            provenance: "last",
            ...(compressed ? { details } : {}),
          },
        };
        const user = {
          ...rewriteEvents[1],
          message: {
            ...rewriteEvents[1].message,
            provenance: "user",
            ...(!compressed ? { details } : {}),
          },
        };
        expect(before.storage[1]?.event_json === null).toBe(compressed);
        expect(before.storage[2]?.event_zstd instanceof Uint8Array).toBe(compressed);
        runOpenClawAgentWriteTransaction((database) => {
          rewriteSqliteTranscriptEventRowsInTransaction(database, scope, [
            { seq: 2, expectedEventJson: JSON.stringify(events[2]), event: first },
            { seq: 1, expectedEventJson: JSON.stringify(events[1]), event: user },
            { seq: 2, expectedEventJson: JSON.stringify(first), event: last },
          ]);
        }, scope);
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
        expect(after.storage[1]?.event_json === null).toBe(!compressed);
        expect(after.storage[1]?.event_zstd instanceof Uint8Array).toBe(!compressed);
        expect(after.storage[2]?.event_json === null).toBe(compressed);
        expect(after.storage[2]?.event_zstd instanceof Uint8Array).toBe(compressed);
        expect(readTranscriptStatsSync(scope)).toMatchObject({
          eventCount: 3,
          sizeBytes: Buffer.byteLength(
            [rewriteEvents[0], user, last].map((event) => JSON.stringify(event)).join("\n"),
          ),
        });
      }, events);
    },
  );

  it("preserves healthy derived rows without FTS access or size scans while raw mutation advances", async () => {
    await withRewriteFixture(({ db, snapshot, rewrite, scope }) => {
      const before = snapshot();
      const work = trackSqliteStatementExecutions(db, ["fts", "size"], (sql) =>
        /\bsession_transcript_fts\b/i.test(sql)
          ? "fts"
          : sql.includes('from "transcript_events"') && sql.includes("octet_length")
            ? "size"
            : null,
      );
      try {
        rewrite({
          ...rewriteEvents[1],
          message: { ...rewriteEvents[1].message, provenance: "new" },
        });
      } finally {
        work.restore();
      }
      const after = snapshot();
      expect(after.generation).not.toBe(before.generation);
      expect(after.updatedAt).toBeGreaterThan(before.updatedAt!);
      expect(after.active).toEqual(before.active);
      expect(after.search).toEqual(before.search);
      expect(after.raw[0]).toEqual(before.raw[0]);
      expect(after.raw[2]).toEqual(before.raw[2]);
      expect(after.raw[1]).toEqual({ ...before.raw[1], event_json: expect.any(String) });
      expect(after.raw[1]?.event_json).not.toBe(before.raw[1]?.event_json);
      expect(after.identities).toEqual(before.identities);
      expect(sessionTranscriptIndexNeedsReconcile(db, scope.sessionId)).toBe(false);
      expect(work.counts).toEqual({ fts: 0, size: 0 });
    });
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

  it.each([false, true])(
    "rolls back payload-arm changes and mutation state on later conflict, initially compressed=%s",
    async (compressed) => {
      const details = { opaque: "rollback metadata ".repeat(2048) };
      const events = [
        rewriteEvents[0],
        {
          ...rewriteEvents[1],
          message: { ...rewriteEvents[1].message, ...(compressed ? { details } : {}) },
        },
        {
          ...rewriteEvents[2],
          message: { ...rewriteEvents[2].message, ...(compressed ? { details } : {}) },
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
                  message: { role: "user", content: "edited", ...(!compressed ? { details } : {}) },
                },
              },
              { seq: 2, expectedEventJson: JSON.stringify(events[2], null, 2), event: events[2] },
            ]);
          }, scope),
        ).toThrow("changed before exact rewrite");
        expect(snapshot()).toEqual(before);
        expect(readTranscriptStatsSync(scope)).toEqual(stats);
      }, events);
    },
  );

  it.each(["dirty", "missing", "lagging", "unclassified", "claimed"] as const)(
    "recovers %s projections on metadata rewrite and fences stale publication",
    async (kind) => {
      await withRewriteFixture(({ db, rewrite, snapshot, scope }) => {
        const before = snapshot();
        const plan = prepareSessionTranscriptProjection(db, scope.sessionId)!;
        if (kind === "missing") {
          db.prepare("DELETE FROM session_transcript_index_state").run();
        } else if (kind === "unclassified") {
          db.prepare("UPDATE session_transcript_active_events SET context_eligible = NULL").run();
        } else if (kind === "lagging") {
          db.prepare("UPDATE session_transcript_index_state SET indexed_seq = -1").run();
        } else {
          db.prepare("UPDATE session_transcript_index_state SET needs_rebuild = 1").run();
        }
        if (kind === "claimed") {
          expect(claimPreparedSessionTranscriptProjectionInTransaction(db, plan, -1)).toBe(true);
          db.prepare("DELETE FROM session_transcript_active_events").run();
          db.prepare("DELETE FROM session_transcript_fts_rows").run();
        }
        expect(sessionTranscriptIndexNeedsReconcile(db, scope.sessionId)).toBe(true);
        rewrite({
          ...rewriteEvents[1],
          message: { ...rewriteEvents[1].message, provenance: "new" },
        });
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
    },
  );

  it.each([
    {
      name: "content",
      seq: 1,
      event: { ...rewriteEvents[1], message: { role: "user", content: "changed" } },
      texts: ["answer", "changed"],
      messages: 2,
    },
    {
      name: "role",
      seq: 1,
      event: { ...rewriteEvents[1], message: { role: "toolResult", content: "question" } },
      texts: ["answer"],
      messages: 2,
    },
    {
      name: "timestamp",
      seq: 1,
      event: { ...rewriteEvents[1], timestamp: 99 },
      texts: ["answer", "question"],
      messages: 2,
    },
    {
      name: "message presence",
      seq: 1,
      event: { type: "message", id: "user", parentId: "root" },
      texts: ["answer"],
      messages: 1,
    },
    {
      name: "parent",
      seq: 2,
      event: { ...rewriteEvents[2], parentId: "root" },
      texts: ["answer"],
      messages: 1,
    },
    {
      name: "leaf control",
      seq: 2,
      event: { type: "leaf", id: "answer", parentId: "user", targetId: "user" },
      texts: ["question"],
      messages: 1,
    },
  ])(
    "rebuilds changed $name facts without duplicate FTS invalidation",
    async ({ event, seq, texts, messages, name }) => {
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
        if (name === "timestamp") {
          expect(search[1]?.timestamp).toBe(99);
        }
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
