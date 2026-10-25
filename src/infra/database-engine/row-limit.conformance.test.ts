import { describe, expect, it } from "vitest";
import { pruneChannelIngressInDatabase } from "../../channels/message/ingress-queue.kernel.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.sqlite-entry.js";
import { addSessionSuggestionInDatabase } from "../../config/sessions/session-suggestion-store.kernel.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../kysely-sync.js";
import { runSqliteImmediateTransactionSync } from "../sqlite-transaction.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import { mixedAgentConnection, useMixedAgentPair } from "./mixed-agent.conformance.test-support.js";

for (const engine of ["sqlite", "postgres"] as const) {
  describe.skipIf(engine === "postgres" && !mixedAgentConnection)(
    `${engine} unbounded retention`,
    () => {
      useMixedAgentPair(engine, engine);

      it("bounds resolved suggestions by tied ID order without deleting pending or other sessions", () =>
        withEngineStoreAdmission(() => {
          const database = openOpenClawAgentDatabase({ agentId: "main" });
          const sessionKey = "agent:main:retention";
          const otherKey = "agent:main:retention-other";
          for (const key of [sessionKey, otherKey]) {
            replaceSessionEntrySync(
              { agentId: "main", storePath: database.path, sessionKey: key },
              { sessionId: key, updatedAt: 1 },
            );
          }
          runSqliteImmediateTransactionSync(database.db, () => {
            const insert = database.db.prepare(
              "INSERT INTO session_suggestions (id, session_key, author_id, text, created_at, state) VALUES (?, ?, 'synthetic', 'idea', 100, ?)",
            );
            for (let index = 0; index < 205; index++) {
              insert.run(
                String(index).padStart(3, "0"),
                sessionKey,
                index % 2 ? "accepted" : "dismissed",
              );
            }
            insert.run("pending", sessionKey, "pending");
            insert.run("other", otherKey, "accepted");
            addSessionSuggestionInDatabase(database, sessionKey, {
              id: "fresh",
              authorId: "synthetic",
              text: "new idea",
              createdAt: 200,
            });
          });
          expect(
            database.db
              .prepare(
                "SELECT id FROM session_suggestions WHERE session_key = ? AND state <> 'pending' ORDER BY id",
              )
              .all(sessionKey),
          ).toEqual(
            Array.from({ length: 200 }, (_, index) => ({ id: String(index + 5).padStart(3, "0") })),
          );
          expect(
            database.db
              .prepare("SELECT id FROM session_suggestions WHERE state = 'pending' ORDER BY id")
              .all(),
          ).toEqual([{ id: "fresh" }, { id: "pending" }]);
          expect(
            database.db
              .prepare("SELECT id FROM session_suggestions WHERE session_key = ?")
              .all(otherKey),
          ).toEqual([{ id: "other" }]);
        }));

      it.each(["pending", "completed", "failed"] as const)(
        "keeps protected %s rows in their original retention slots across batches",
        (state) =>
          withEngineStoreAdmission(() => {
            const database = openOpenClawStateDatabase();
            const query = getNodeSqliteKysely<Pick<DB, "channel_ingress_events">>(database.db);
            const queueName = `limit-${state}`;
            const protectedIds = Array.from({ length: 500 }, (_, i) =>
              String(i + 18).padStart(4, "0"),
            );
            runOpenClawStateWriteTransaction(
              () => {
                executeSqliteQuerySync(
                  database.db,
                  query.insertInto("channel_ingress_events").values(
                    Array.from({ length: 520 }, (_, index) => ({
                      queue_name: queueName,
                      event_id: String(index).padStart(4, "0"),
                      channel_id: "synthetic",
                      account_id: "account",
                      status: state,
                      payload_json: "null",
                      received_at: 100,
                      updated_at: 100,
                    })),
                  ),
                );
              },
              { database },
            );
            const maxOption =
              state === "pending"
                ? "pendingMaxEntries"
                : state === "completed"
                  ? "completedMaxEntries"
                  : "failedMaxEntries";
            const prune = (max: number, protectIds: string[]) =>
              runOpenClawStateWriteTransaction(
                () =>
                  pruneChannelIngressInDatabase(database.db, {
                    queueName,
                    options: { [maxOption]: max, protectIds },
                    now: 200,
                  }),
                { database },
              );
            const remaining = () =>
              executeSqliteQuerySync(
                database.db,
                query
                  .selectFrom("channel_ingress_events")
                  .select("event_id")
                  .where("queue_name", "=", queueName)
                  .orderBy("event_id", "asc"),
              ).rows.map((row) => row.event_id);
            expect(prune(2, protectedIds)).toBe(18);
            expect(remaining()).toEqual([...protectedIds, "0518", "0519"]);
            expect(prune(2, protectedIds)).toBe(0);
            expect(prune(0, protectedIds)).toBe(2);
            expect(remaining()).toEqual(protectedIds);
            expect(prune(0, [])).toBe(500);
            expect(remaining()).toEqual([]);
          }),
      );
    },
  );
}
