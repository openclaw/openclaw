import type { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { persistSessionTranscriptTurn } from "./session-accessor.js";
import {
  readRecentSessionTranscriptActiveEvents,
  readSessionTranscriptMessageEventPage,
} from "./session-accessor.sqlite-active-events.js";
import { withCurrentProjectionSnapshot } from "./session-accessor.sqlite-active-projection.js";
import { readActiveTranscriptStats } from "./session-accessor.sqlite-history.test-support.js";
import { rotateTranscriptGenerationInTransaction } from "./session-accessor.sqlite-transcript-state.js";
import {
  appendTranscriptEventsInTransaction,
  appendTranscriptEventInTransaction,
  replaceSqliteTranscriptEventsInTransaction,
  rewriteSqliteTranscriptEventRowsInTransaction,
} from "./session-accessor.sqlite-transcript-store.js";
import { appendTranscriptEvent } from "./session-accessor.sqlite-transcript-write.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.test-support.js";
import {
  listSessionsNeedingTranscriptIndexReconcile,
  sessionTranscriptIndexNeedsReconcile,
} from "./session-transcript-index.js";
import { SessionTranscriptProjectionUnavailableError } from "./session-transcript-projection-error.js";
import {
  hasUnclassifiedSessionTranscriptEvents,
  prepareSessionTranscriptProjection as prepareProjection,
  claimPreparedSessionTranscriptProjectionInTransaction as claimProjection,
  deletePreparedSessionTranscriptProjectionChunkInTransaction as deleteProjectionChunk,
  appendPreparedSessionTranscriptProjectionChunkInTransaction as appendProjectionChunk,
  finalizePreparedSessionTranscriptProjectionInTransaction as finalizeProjection,
  type PreparedSessionTranscriptProjection,
} from "./session-transcript-projection-rebuild.js";
import { waitForSessionTranscriptIndexReconcile } from "./session-transcript-reconcile.js";

const sessionId = "eligibility";
const entries = [
  { type: "custom", id: "bootstrap", parentId: null, customType: "bootstrap-completed", data: {} },
  {
    type: "message",
    id: "user",
    parentId: "bootstrap",
    message: { role: "user", content: "question" },
  },
  {
    type: "message",
    id: "display",
    parentId: "user",
    message: {
      role: "custom",
      customType: "activity",
      display: true,
      excludeFromContext: true,
      content: "activity",
    },
  },
  {
    type: "message",
    id: "answer",
    parentId: "display",
    message: { role: "assistant", content: "answer", usage: { input: 100, output: 10 } },
  },
] as const;

function projectionFixture(env: NodeJS.ProcessEnv) {
  const scope = { agentId: "main", env, sessionId, sessionKey: "agent:main:eligibility" };
  const db = () => requireNativeSqliteDatabase(openOpenClawAgentDatabase(scope).db);
  const write = <T>(run: Parameters<typeof runOpenClawAgentWriteTransaction<T>>[0]) =>
    runOpenClawAgentWriteTransaction(run, scope);
  const plan = () => {
    const prepared = prepareProjection(db(), sessionId);
    if (!prepared) {
      throw new Error("missing prepared projection");
    }
    return prepared;
  };
  const claim = (prepared: PreparedSessionTranscriptProjection) =>
    expect(claimProjection(db(), prepared, -1)).toBe(true);
  const install = (prepared: PreparedSessionTranscriptProjection, partial = false) => {
    const connection = db();
    expect(
      deleteProjectionChunk(connection, {
        sessionId,
        maxRowsPerTable: 512,
      }),
    ).toEqual({ hasMore: false });
    appendProjectionChunk(connection, {
      sessionId,
      activeRows: partial ? prepared.activeRows.slice(0, 1) : prepared.activeRows,
      ...(partial ? {} : { ftsRows: prepared.ftsRows }),
    });
  };
  const publish = (prepared: PreparedSessionTranscriptProjection, partial = false) => {
    claim(prepared);
    install(prepared, partial);
  };
  const finalize = (prepared: PreparedSessionTranscriptProjection) =>
    finalizeProjection(db(), prepared, -1);
  const rewrite = (excludeFromContext: boolean) => ({
    seq: 2,
    expectedEventJson: JSON.stringify(entries[2]),
    event: { ...entries[2], message: { ...entries[2].message, excludeFromContext } },
  });
  return { scope, db, rewrite, write, plan, publish, finalize, claim, install };
}

function projectionRows(db: DatabaseSync) {
  return db
    .prepare(
      "SELECT active_position, event_seq, message_position, context_eligible FROM session_transcript_active_events WHERE session_id = ? ORDER BY active_position",
    )
    .all(sessionId);
}

function rawRows(db: DatabaseSync) {
  return db
    .prepare(
      "SELECT seq, event_json, created_at FROM transcript_events WHERE session_id = ? ORDER BY seq",
    )
    .all(sessionId);
}

async function prepareDirtyProjection(env: NodeJS.ProcessEnv, label: string) {
  const f = projectionFixture(env);
  if (label === "invalid-leaf") {
    await appendTranscriptEvent(f.scope, {
      type: "leaf",
      id: "invalid-leaf",
      parentId: null,
      targetId: "missing",
    });
  } else {
    await persistSessionTranscriptTurn(f.scope, {
      messages: [{ eventId: "root", parentId: null, message: { role: "user", content: "root" } }],
      touchSessionEntry: false,
    });
  }
  const db = f.db();
  db.prepare("UPDATE session_transcript_index_state SET needs_rebuild=1 WHERE session_id=?").run(
    sessionId,
  );
  const plan = f.plan();
  return {
    ...f,
    database: { db },
    plan,
    publish: () => {
      f.write(() => f.claim(plan));
      f.write(() => f.install(plan));
    },
    finalize: () => f.write(() => f.finalize(plan)),
    status: () =>
      db
        .prepare("SELECT needs_rebuild FROM session_transcript_index_state WHERE session_id=?")
        .get(sessionId),
  };
}

function withDirtyProjection(
  label: string,
  run: (f: Awaited<ReturnType<typeof prepareDirtyProjection>>) => Promise<void>,
) {
  return withOpenClawTestState(
    { label: "projection-catchup", scenario: "minimal" },
    async ({ env }) => run(await prepareDirtyProjection(env, label)),
  );
}

it("converges an older current-watermark rebuild and a following append without changing history", async () => {
  await withOpenClawTestState({ label: "transcript-eligibility" }, async (state) => {
    const { scope, db: open } = projectionFixture(state.env);
    runOpenClawAgentWriteTransaction((database) => {
      expect(appendTranscriptEventsInTransaction(database, scope, entries)).toBe(entries.length);
    }, scope);
    const db = open();
    const expectedRows = projectionRows(db);
    expect(expectedRows.map((row) => row.context_eligible)).toEqual([1, 1, 0, 1]);
    expect(readRecentSessionTranscriptActiveEvents(scope, 3)).toEqual([
      entries[0],
      entries[1],
      entries[3],
    ]);
    const before = rawRows(db);

    // Older projection writers omit the new column even when they publish a current watermark.
    db.prepare(
      "UPDATE session_transcript_active_events SET context_eligible = NULL WHERE session_id = ?",
    ).run(sessionId);
    expect(
      db
        .prepare(
          "SELECT needs_rebuild, indexed_seq FROM session_transcript_index_state WHERE session_id = ?",
        )
        .get(sessionId),
    ).toEqual({ needs_rebuild: 0, indexed_seq: 3 });
    expect(sessionTranscriptIndexNeedsReconcile(db, sessionId)).toBe(true);
    expect(listSessionsNeedingTranscriptIndexReconcile(db)).toContain(sessionId);
    expect(() => readActiveTranscriptStats(scope)).toThrow(
      SessionTranscriptProjectionUnavailableError,
    );
    runOpenClawAgentWriteTransaction((database) => {
      appendTranscriptEventsInTransaction(database, scope, [
        entries[3],
        {
          type: "message",
          id: "new",
          parentId: "answer",
          message: { role: "user", content: "next" },
        },
        entries[3],
      ]);
      expect(
        db
          .prepare("SELECT needs_rebuild FROM session_transcript_index_state WHERE session_id = ?")
          .get(sessionId),
      ).toEqual({ needs_rebuild: 1 });
    }, scope);
    await waitForSessionTranscriptIndexReconcile(scope);

    expect(hasUnclassifiedSessionTranscriptEvents(db, sessionId)).toBe(false);
    expect(sessionTranscriptIndexNeedsReconcile(db, sessionId)).toBe(false);
    expect(rawRows(db).slice(0, before.length)).toEqual(before);
    expect(projectionRows(db).slice(0, expectedRows.length)).toEqual(expectedRows);
    expect(readActiveTranscriptStats(scope).eventCount).toBe(4);
    expect(
      readSessionTranscriptMessageEventPage(scope, { offset: 0, maxMessages: 10 }).totalMessages,
    ).toBe(4);
  });
});

it("reclassifies exact rewrites in both directions and deletes eligibility with the transcript", async () => {
  await withOpenClawTestState({ label: "transcript-eligibility-rewrite" }, async (state) => {
    const { scope, db: open } = projectionFixture(state.env);
    await replaceTranscriptEvents(scope, [...entries]);
    const db = open();
    for (const excludeFromContext of [false, true]) {
      const before = rawRows(db);
      const row = before[2];
      if (typeof row?.event_json !== "string") {
        throw new Error("missing activity row");
      }
      const expectedEventJson = row.event_json;
      const event = { ...entries[2], message: { ...entries[2].message, excludeFromContext } };
      runOpenClawAgentWriteTransaction((database) => {
        rewriteSqliteTranscriptEventRowsInTransaction(database, scope, [
          { seq: 2, event, expectedEventJson },
        ]);
      }, scope);
      expect(projectionRows(db)[2]?.context_eligible).toBe(excludeFromContext ? 0 : 1);
      expect(readActiveTranscriptStats(scope).eventCount).toBe(excludeFromContext ? 3 : 4);
      expect(
        readSessionTranscriptMessageEventPage(scope, { offset: 0, maxMessages: 10 }).totalMessages,
      ).toBe(3);
      expect(rawRows(db).filter((entry) => entry.seq !== 2)).toEqual(
        before.filter((entry) => entry.seq !== 2),
      );
    }
    await replaceTranscriptEvents(scope, []);
    expect(projectionRows(db)).toEqual([]);
    expect(rawRows(db)).toEqual([]);
    expect(readActiveTranscriptStats(scope)).toEqual({ eventCount: 0, sizeBytes: 0 });
  });
});

it("keeps a prepared projection unpublished after a same-sequence rewrite", async () => {
  await withOpenClawTestState({ label: "transcript-eligibility-stale" }, async (state) => {
    const f = projectionFixture(state.env);
    await replaceTranscriptEvents(f.scope, [...entries]);
    const plan = f.plan();
    f.write((database) => {
      rewriteSqliteTranscriptEventRowsInTransaction(database, f.scope, [f.rewrite(false)]);
      f.publish(plan);
      expect(f.finalize(plan)).toBe(false);
    });
    expect(() => readActiveTranscriptStats(f.scope)).toThrow(
      SessionTranscriptProjectionUnavailableError,
    );
    await waitForSessionTranscriptIndexReconcile(f.scope);
    expect(readActiveTranscriptStats(f.scope).eventCount).toBe(4);
  });
});

it.each(["interrupted", "rewrite", "delete"])(
  "fences partial eligibility publication after %s work",
  async (change) => {
    await withOpenClawTestState({ label: "transcript-eligibility-claim" }, async (state) => {
      const f = projectionFixture(state.env);
      const { scope } = f;
      await replaceTranscriptEvents(scope, [...entries]);
      const db = f.db();
      db.prepare(
        "UPDATE session_transcript_active_events SET context_eligible = NULL WHERE session_id = ?",
      ).run(sessionId);
      const plan = f.plan();
      f.write(() => f.publish(plan, true));
      // Removing the last NULL is not publication: only finalization publishes the projection.
      expect(hasUnclassifiedSessionTranscriptEvents(db, sessionId)).toBe(false);
      expect(() => withCurrentProjectionSnapshot(scope, () => "visible")).toThrow(
        SessionTranscriptProjectionUnavailableError,
      );

      if (change !== "interrupted") {
        f.write((database) => {
          if (change === "rewrite") {
            rewriteSqliteTranscriptEventRowsInTransaction(database, scope, [f.rewrite(false)]);
          } else {
            replaceSqliteTranscriptEventsInTransaction(database, scope, []);
          }
          expect(f.finalize(plan)).toBe(false);
        });
      }
      await waitForSessionTranscriptIndexReconcile(scope);
      expect(sessionTranscriptIndexNeedsReconcile(db, sessionId)).toBe(false);
      expect(readActiveTranscriptStats(scope).eventCount).toBe(
        change === "delete" ? 0 : change === "rewrite" ? 4 : 3,
      );
      expect(projectionRows(db).every((row) => row.context_eligible !== null)).toBe(true);
    });
  },
);

it("does not claim a session deleted after preparation", () =>
  withDirtyProjection("deleted", async (fixture) => {
    fixture.write((database) => {
      database.db
        .prepare("DELETE FROM session_windows WHERE session_id = ?")
        .run(fixture.scope.sessionId);
      expect(claimProjection(database.db, fixture.plan, -41)).toBe(false);
    });
  }));

it.each(["invalid-leaf", "oversized"])("keeps an unsafe $0 catch-up unpublished", (label) =>
  withDirtyProjection(label, async (fixture) => {
    if (label === "invalid-leaf") {
      expect(fixture.plan.sourceHasInvalidLeafControl).toBe(true);
      await persistSessionTranscriptTurn(fixture.scope, {
        messages: [
          {
            eventId: "racing-continuation",
            parentId: null,
            message: { role: "assistant", content: "arrived after preparation" },
          },
        ],
        touchSessionEntry: false,
      });
    } else {
      fixture.write((database) => {
        appendTranscriptEventInTransaction(
          database,
          fixture.scope,
          {
            type: "message",
            id: "oversized-tail",
            parentId: "root",
            message: { role: "assistant", content: "x".repeat(257 * 1024) },
          },
          { scheduleProjectionReconcile: false },
        );
      });
    }
    fixture.publish();
    expect(fixture.finalize()).toBe(false);
    expect(fixture.status()).toEqual({ needs_rebuild: 1 });
  }),
);

it.each(["append", "reset", "branch", "generation", "claim"])(
  "finalizes only an append-only source change (%s)",
  (label) =>
    withDirtyProjection(label, async (fixture) => {
      if (label === "append") {
        fixture.write((database) => {
          for (let index = 0; index < 10; index++) {
            appendTranscriptEventInTransaction(
              database,
              fixture.scope,
              {
                type: "message",
                id: `racing-append-${index}`,
                parentId: index === 0 ? "root" : `racing-append-${index - 1}`,
                message: { role: "assistant", content: `arrived after preparation ${index}` },
              },
              { scheduleProjectionReconcile: false },
            );
          }
        });
      }
      const claimId = -1;
      fixture.publish();
      fixture.write((database) => {
        if (label === "claim") {
          database.db
            .prepare(
              "UPDATE session_transcript_index_state SET updated_at = ? WHERE session_id = ?",
            )
            .run(claimId - 1, fixture.scope.sessionId);
        } else if (label === "generation") {
          rotateTranscriptGenerationInTransaction(database, fixture.scope.sessionId);
        } else if (label !== "append") {
          appendTranscriptEventInTransaction(
            database,
            fixture.scope,
            label === "reset"
              ? { type: "reset", id: "racing-reset", parentId: "root", firstKeptEntryId: "root" }
              : {
                  type: "message",
                  id: "racing-branch",
                  parentId: null,
                  message: { role: "assistant", content: "branch" },
                },
            { scheduleProjectionReconcile: false },
          );
        }
        expect(finalizeProjection(database.db, fixture.plan, claimId)).toBe(label === "append");
      });
      if (label === "append") {
        expect(
          fixture.database.db
            .prepare(
              "SELECT indexed_seq, needs_rebuild, active_message_count FROM session_transcript_index_state WHERE session_id = ?",
            )
            .get(fixture.scope.sessionId),
        ).toEqual({
          active_message_count: 11,
          indexed_seq: fixture.plan.sourceIndexedSeq + 10,
          needs_rebuild: 0,
        });
        return;
      }
      expect(fixture.status()).toEqual({ needs_rebuild: 1 });
    }),
);
