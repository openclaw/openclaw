import type { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import { withOpenClawTestState as withState } from "../../test-utils/openclaw-test-state.js";
import { persistSessionTranscriptTurn } from "./session-accessor.js";
import {
  readRecentSessionTranscriptActiveEvents,
  readSessionTranscriptMessageEventPage as readMessagePage,
} from "./session-accessor.sqlite-active-events.js";
import { withCurrentProjectionSnapshot } from "./session-accessor.sqlite-active-projection.js";
import { readActiveTranscriptStats as readStats } from "./session-accessor.sqlite-history.test-support.js";
import { rotateTranscriptGenerationInTransaction } from "./session-accessor.sqlite-transcript-state.js";
import {
  appendTranscriptEventsInTransaction as appendEvents,
  appendTranscriptEventInTransaction as appendEvent,
  replaceSqliteTranscriptEventsInTransaction,
  rewriteSqliteTranscriptEventRowsInTransaction as rewriteEvents,
} from "./session-accessor.sqlite-transcript-store.js";
import { appendTranscriptEvent } from "./session-accessor.sqlite-transcript-write.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.test-support.js";
import {
  listSessionsNeedingTranscriptIndexReconcile,
  sessionTranscriptIndexNeedsReconcile as needsReconcile,
} from "./session-transcript-index.js";
import { SessionTranscriptProjectionUnavailableError as ProjectionUnavailable } from "./session-transcript-projection-error.js";
import {
  prepareSessionTranscriptProjection as prepareProjection,
  claimPreparedSessionTranscriptProjectionInTransaction as claimProjection,
  deletePreparedSessionTranscriptProjectionChunkInTransaction as deleteProjectionChunk,
  appendPreparedSessionTranscriptProjectionChunkInTransaction as appendProjectionChunk,
  finalizePreparedSessionTranscriptProjectionInTransaction as finalizeProjection,
  type PreparedSessionTranscriptProjection,
} from "./session-transcript-projection-rebuild.js";
import { waitForSessionTranscriptIndexReconcile as reconcile } from "./session-transcript-reconcile.js";
import { messageEvent } from "./transcript-message.test-support.js";

const sessionId = "eligibility";
const entries = [
  { type: "custom", id: "bootstrap", parentId: null, customType: "bootstrap-completed", data: {} },
  messageEvent("user", "bootstrap", { role: "user", content: "question" }),
  messageEvent("display", "user", {
    role: "custom",
    content: "activity",
    customType: "activity",
    display: true,
    excludeFromContext: true,
  }),
  messageEvent("answer", "display", {
    role: "assistant",
    content: "answer",
    usage: { input: 100, output: 10 },
  }),
] as const;

function projectionFixture(env: NodeJS.ProcessEnv) {
  const scope = { agentId: "main", env, sessionId, sessionKey: "agent:main:eligibility" };
  const db = () => requireNativeSqliteDatabase(openOpenClawAgentDatabase(scope).db);
  const write = <T>(run: Parameters<typeof runOpenClawAgentWriteTransaction<T>>[0]) =>
    runOpenClawAgentWriteTransaction(run, scope);
  const indexState = (columns = "needs_rebuild") =>
    db()
      .prepare(`SELECT ${columns} FROM session_transcript_index_state WHERE session_id = ?`)
      .get(sessionId);
  const unclassify = () =>
    db()
      .prepare(
        "UPDATE session_transcript_active_events SET context_eligible = NULL WHERE session_id = ?",
      )
      .run(sessionId);
  const plan = () => {
    const prepared = prepareProjection(db(), sessionId);
    if (!prepared) {
      throw new Error("missing prepared projection");
    }
    return prepared;
  };
  const publish = (
    prepared: PreparedSessionTranscriptProjection,
    partial = false,
    run: (action: () => void) => void = (action) => action(),
  ) => {
    run(() => expect(claimProjection(db(), prepared, -1)).toBe(true));
    run(() => {
      const connection = db();
      expect(deleteProjectionChunk(connection, { sessionId, maxRowsPerTable: 512 })).toEqual({
        hasMore: false,
      });
      appendProjectionChunk(connection, {
        sessionId,
        activeRows: partial ? prepared.activeRows.slice(0, 1) : prepared.activeRows,
        ...(partial ? {} : { ftsRows: prepared.ftsRows }),
      });
    });
  };
  const finalize = (prepared: PreparedSessionTranscriptProjection) =>
    finalizeProjection(db(), prepared, -1);
  const rewrite = (excludeFromContext: boolean) => ({
    seq: 2,
    expectedEventJson: JSON.stringify(entries[2]),
    event: { ...entries[2], message: { ...entries[2].message, excludeFromContext } },
  });
  return { scope, db, rewrite, write, plan, publish, finalize, indexState, unclassify };
}

const projectionRows = (db: DatabaseSync) =>
  db
    .prepare(
      "SELECT active_position, event_seq, message_position, context_eligible FROM session_transcript_active_events WHERE session_id = ? ORDER BY active_position",
    )
    .all(sessionId);
const rawRows = (db: DatabaseSync) =>
  db
    .prepare(
      "SELECT seq, event_json, created_at FROM transcript_events WHERE session_id = ? ORDER BY seq",
    )
    .all(sessionId);

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
    plan,
    // Catch-up fixtures deliberately claim and install in separate transactions.
    publish: () => f.publish(plan, false, f.write),
    finalize: () => f.write(() => f.finalize(plan)),
    status: f.indexState,
    append: (
      database: Parameters<typeof appendEvent>[0],
      event: Parameters<typeof appendEvent>[2],
    ) => appendEvent(database, f.scope, event, { scheduleProjectionReconcile: false }),
  };
}

function withDirtyProjection(
  label: string,
  run: (f: Awaited<ReturnType<typeof prepareDirtyProjection>>) => Promise<void>,
) {
  return withState({ label: "projection-catchup", scenario: "minimal" }, async ({ env }) =>
    run(await prepareDirtyProjection(env, label)),
  );
}

it("converges an older current-watermark rebuild and a following append without changing history", () =>
  withState({ label: "transcript-eligibility" }, async (state) => {
    const { scope, db: open, indexState, unclassify } = projectionFixture(state.env);
    runOpenClawAgentWriteTransaction((database) => {
      expect(appendEvents(database, scope, entries)).toBe(entries.length);
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
    unclassify();
    expect(indexState("needs_rebuild, indexed_seq")).toEqual({ needs_rebuild: 0, indexed_seq: 3 });
    expect(needsReconcile(db, sessionId)).toBe(true);
    expect(listSessionsNeedingTranscriptIndexReconcile(db)).toContain(sessionId);
    expect(() => readStats(scope)).toThrow(ProjectionUnavailable);
    runOpenClawAgentWriteTransaction((database) => {
      appendEvents(database, scope, [
        entries[3],
        messageEvent("new", "answer", { role: "user", content: "next" }),
        entries[3],
      ]);
      expect(indexState()).toEqual({ needs_rebuild: 1 });
    }, scope);
    await reconcile(scope);

    expect(needsReconcile(db, sessionId)).toBe(false);
    expect(rawRows(db).slice(0, before.length)).toEqual(before);
    expect(projectionRows(db).slice(0, expectedRows.length)).toEqual(expectedRows);
    expect(readStats(scope).eventCount).toBe(4);
    expect(readMessagePage(scope, { offset: 0, maxMessages: 10 }).totalMessages).toBe(4);
  }));

it("reclassifies exact rewrites in both directions and deletes eligibility with the transcript", () =>
  withState({ label: "transcript-eligibility-rewrite" }, async (state) => {
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
        rewriteEvents(database, scope, [{ seq: 2, event, expectedEventJson }]);
      }, scope);
      expect(projectionRows(db)[2]?.context_eligible).toBe(excludeFromContext ? 0 : 1);
      expect(readStats(scope).eventCount).toBe(excludeFromContext ? 3 : 4);
      expect(readMessagePage(scope, { offset: 0, maxMessages: 10 }).totalMessages).toBe(3);
      expect(rawRows(db).filter((entry) => entry.seq !== 2)).toEqual(
        before.filter((entry) => entry.seq !== 2),
      );
    }
    await replaceTranscriptEvents(scope, []);
    expect(projectionRows(db)).toEqual([]);
    expect(rawRows(db)).toEqual([]);
    expect(readStats(scope)).toEqual({ eventCount: 0, sizeBytes: 0 });
  }));

it("keeps a prepared projection unpublished after a same-sequence rewrite", () =>
  withState({ label: "transcript-eligibility-stale" }, async (state) => {
    const f = projectionFixture(state.env);
    await replaceTranscriptEvents(f.scope, [...entries]);
    const plan = f.plan();
    f.write((database) => {
      rewriteEvents(database, f.scope, [f.rewrite(false)]);
      f.publish(plan);
      expect(f.finalize(plan)).toBe(false);
    });
    expect(() => readStats(f.scope)).toThrow(ProjectionUnavailable);
    await reconcile(f.scope);
    expect(readStats(f.scope).eventCount).toBe(4);
  }));

it.each(["interrupted", "rewrite", "delete"])(
  "fences partial eligibility publication after %s work",
  (change) =>
    withState({ label: "transcript-eligibility-claim" }, async (state) => {
      const f = projectionFixture(state.env);
      const { scope } = f;
      await replaceTranscriptEvents(scope, [...entries]);
      const db = f.db();
      f.unclassify();
      const plan = f.plan();
      f.write(() => f.publish(plan, true));
      // Removing the last NULL is not publication: only finalization publishes the projection.
      expect(projectionRows(db).map((row) => row.context_eligible)).toEqual([1]);
      expect(() => withCurrentProjectionSnapshot(scope, () => "visible")).toThrow(
        ProjectionUnavailable,
      );

      if (change !== "interrupted") {
        f.write((database) => {
          if (change === "rewrite") {
            rewriteEvents(database, scope, [f.rewrite(false)]);
          } else {
            replaceSqliteTranscriptEventsInTransaction(database, scope, []);
          }
          expect(f.finalize(plan)).toBe(false);
        });
      }
      await reconcile(scope);
      expect(needsReconcile(db, sessionId)).toBe(false);
      expect(readStats(scope).eventCount).toBe(
        change === "delete" ? 0 : change === "rewrite" ? 4 : 3,
      );
      expect(projectionRows(db).every((row) => row.context_eligible !== null)).toBe(true);
    }),
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
        fixture.append(
          database,
          messageEvent("oversized-tail", "root", {
            role: "assistant",
            content: "x".repeat(257 * 1024),
          }),
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
            fixture.append(
              database,
              messageEvent(
                `racing-append-${index}`,
                index === 0 ? "root" : `racing-append-${index - 1}`,
                { role: "assistant", content: `arrived after preparation ${index}` },
              ),
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
          fixture.append(
            database,
            label === "reset"
              ? { type: "reset", id: "racing-reset", parentId: "root", firstKeptEntryId: "root" }
              : messageEvent("racing-branch", null, { role: "assistant", content: "branch" }),
          );
        }
        expect(finalizeProjection(database.db, fixture.plan, claimId)).toBe(label === "append");
      });
      if (label === "append") {
        expect(fixture.indexState("indexed_seq, needs_rebuild, active_message_count")).toEqual({
          active_message_count: 11,
          indexed_seq: fixture.plan.sourceIndexedSeq + 10,
          needs_rebuild: 0,
        });
        return;
      }
      expect(fixture.status()).toEqual({ needs_rebuild: 1 });
    }),
);
