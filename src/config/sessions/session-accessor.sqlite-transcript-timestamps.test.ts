import { afterEach, describe, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import {
  closeOpenClawAgentDatabasesForTest,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { appendTranscriptEventInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import { hydrateSessionActorState } from "./session-actor-hydration.worker.js";
import { withSessionActorTransactionState } from "./session-actor-transaction.js";
import { createSessionCompoundWorkerFixture } from "./session-compound-worker.test-support.js";

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

describe("SQLite transcript timestamp writes", () => {
  it.each(["actor", "batch"] as const)(
    "preserves attempt recency and mutation watermarks with a known %s window",
    async (mode) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const { database, scope } = createSessionCompoundWorkerFixture();
        database.db
          .prepare(
            "UPDATE session_windows SET updated_at = 1, transcript_updated_at = 3000, transcript_observed_at = 4000 WHERE session_id = ?",
          )
          .run(scope.sessionId);
        const identity = readOpenClawAgentDatabaseIdentity(database);
        if (typeof identity.identity !== "string") {
          throw new Error("Fixture requires a physical database");
        }
        const actor =
          mode === "actor"
            ? hydrateSessionActorState(
                database,
                {
                  sessionKey: scope.sessionKey,
                  database: {
                    kind: "file",
                    physicalIdentity: identity.identity,
                    birthtime: identity.birthtime,
                    nativeLocation: database.path,
                  },
                },
                { epoch: "test", sequence: 0 },
                "initial",
              )
            : undefined;
        const cursor = {};
        const readWindow = () =>
          database.db
            .prepare(
              "SELECT updated_at, transcript_updated_at, transcript_observed_at FROM session_windows WHERE session_id = ?",
            )
            .get(scope.sessionId);
        const writes = trackSqliteStatementExecutions(database.db, ["window"], (sql) =>
          /^(?:insert into|update) "session_windows"/i.test(sql) ? "window" : null,
        );
        const clock = vi.spyOn(Date, "now").mockReturnValue(2000);
        const append = (
          id: string,
          timestamp: number,
          options: Parameters<typeof appendTranscriptEventInTransaction>[3] = {},
        ) => {
          writes.counts.window = 0;
          return appendTranscriptEventInTransaction(
            database,
            { ...scope, path: database.path },
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
          expect(readWindow()).toEqual({
            updated_at: updatedAt,
            transcript_updated_at: mutationAt,
            transcript_observed_at: observedAt,
          });
          if (actor) {
            expect(actor.window?.updated_at).toBe(updatedAt);
            expect(actor.hot.transcript.version.updatedAt).toBe(mutationAt);
          }
        };
        try {
          runOpenClawAgentWriteTransaction(
            () => {
              const run = () => {
                expect(append("first", 1000)).not.toBe(false);
                assertWindow(1000, 4001);
                expect(writes.counts.window).toBe(mode === "actor" ? 1 : 2);
                expect(append("second", 2000)).not.toBe(false);
                assertWindow(2000, 4002);
                expect(writes.counts.window).toBe(1);
                expect(append("second", 5000)).toBe(false);
                assertWindow(5000, 4002);
                expect(append("deduped", 6000, { idempotencyKeyMode: "dedupe" })).toBe(false);
                assertWindow(6000, 4002);
                expect(append("untouched", 7000, { touchMutation: false })).not.toBe(false);
                assertWindow(7000, 4002);
                expect(
                  appendTranscriptEventInTransaction(
                    database,
                    { ...scope, path: database.path },
                    {
                      type: "compaction",
                      id: "degraded",
                      parentId: "untouched",
                      timestamp: 8000,
                      summary: "retained summary",
                      firstKeptEntryId: "first",
                      tokensBefore: 10,
                      details: { readFiles: [], modifiedFiles: [], qualityDegraded: true },
                    },
                    {},
                    cursor,
                  ),
                ).not.toBe(false);
                assertWindow(1, 4003, 4002);
              };
              return actor ? withSessionActorTransactionState(database, actor, run) : run();
            },
            { agentId: "main", path: database.path },
          );
        } finally {
          clock.mockRestore();
          writes.restore();
        }
        assertWindow(1, 4003, 4002);
      });
    },
  );
});
