import { expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { runOpenClawAgentWriteTransaction } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { appendTranscriptEventInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import { hydrateSessionActorState } from "./session-actor-hydration.worker.js";
import { withSessionActorTransactionState } from "./session-actor-transaction.js";
import { sessionActorFileTarget } from "./session-actor-worker.test-support.js";
import { createSessionCompoundWorkerFixture } from "./session-compound-worker.test-support.js";

it.each(["actor", "batch"] as const)(
  "preserves attempt recency and mutation watermarks with a known %s window",
  (mode) =>
    withOpenClawTestState({ scenario: "minimal" }, async () => {
      const { database, scope } = createSessionCompoundWorkerFixture();
      database.db
        .prepare(
          "UPDATE session_windows SET updated_at = 1, transcript_updated_at = 3000, transcript_observed_at = 4000 WHERE session_id = ?",
        )
        .run(scope.sessionId);
      const actor =
        mode === "actor"
          ? hydrateSessionActorState(
              database,
              sessionActorFileTarget(database, scope.sessionKey),
              { epoch: "test", sequence: 0 },
              "initial",
            )
          : undefined;
      const cursor = {};
      const appendEvent = appendTranscriptEventInTransaction.bind(null, database, {
        ...scope,
        path: database.path,
      });
      const window = database.db.prepare(
        "SELECT updated_at, transcript_updated_at, transcript_observed_at FROM session_windows WHERE session_id = ?",
      );
      const writes = trackSqliteStatementExecutions(database.db, ["window"], (sql) =>
        /^(?:insert into|update) "session_windows"/i.test(sql) ? "window" : null,
      );
      const append = (
        id: string,
        timestamp: number,
        options: Parameters<typeof appendTranscriptEventInTransaction>[3] = {},
      ) => {
        writes.counts.window = 0;
        return appendEvent(
          {
            type: "message",
            id,
            timestamp,
            parentId: null,
            message: { role: "user", content: id, idempotencyKey: "once" },
          },
          options,
          cursor,
        );
      };
      const assertWindow = (updatedAt: number, mutationAt: number, observedAt = 4000) => {
        expect(window.get(scope.sessionId)).toEqual({
          updated_at: updatedAt,
          transcript_updated_at: mutationAt,
          transcript_observed_at: observedAt,
        });
        if (actor) {
          expect(actor.window?.updated_at).toBe(updatedAt);
          expect(actor.hot.transcript.version.updatedAt).toBe(mutationAt);
        }
      };
      const compaction = {
        type: "compaction",
        id: "degraded",
        parentId: "untouched",
        timestamp: 8000,
        summary: "retained summary",
        firstKeptEntryId: "first",
        tokensBefore: 10,
        details: { readFiles: [], modifiedFiles: [], qualityDegraded: true },
      };
      const run = () => {
        for (const [id, timestamp, options, inserted, mutationAt] of [
          ["first", 1000, {}, true, 4001],
          ["second", 2000, {}, true, 4002],
          ["second", 5000, {}, false, 4002],
          ["deduped", 6000, { idempotencyKeyMode: "dedupe" }, false, 4002],
          ["untouched", 7000, { touchMutation: false }, true, 4002],
        ] as const) {
          expect(append(id, timestamp, options) !== false).toBe(inserted);
          assertWindow(timestamp, mutationAt);
          if (timestamp <= 2000) {
            expect(writes.counts.window).toBe(1);
          }
        }
        expect(appendEvent(compaction, {}, cursor)).not.toBe(false);
        assertWindow(1, 4003, 4002);
      };
      const clock = vi.spyOn(Date, "now").mockReturnValue(2000);
      try {
        runOpenClawAgentWriteTransaction(
          () => (actor ? withSessionActorTransactionState(database, actor, run) : run()),
          { agentId: "main", path: database.path },
        );
      } finally {
        clock.mockRestore();
        writes.restore();
      }
      assertWindow(1, 4003, 4002);
    }),
);
