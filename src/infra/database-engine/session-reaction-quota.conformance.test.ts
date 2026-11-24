import { describe, expect, it } from "vitest";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.sqlite-entry.js";
import { appendTranscriptEventsInTransaction } from "../../config/sessions/session-accessor.sqlite-transcript-store.js";
import {
  SessionReactionLimitError,
  SessionReactionMessageMissingError,
} from "../../config/sessions/session-reaction-errors.js";
import { setSessionReactionInDatabase } from "../../config/sessions/session-reaction-store.kernel.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { runSqliteImmediateTransactionSync } from "../sqlite-transaction.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import { mixedAgentConnection, useMixedAgentPair } from "./mixed-agent.conformance.test-support.js";

for (const engine of ["sqlite", "postgres"] as const) {
  describe.skipIf(engine === "postgres" && !mixedAgentConnection)(
    `${engine} reaction quota`,
    () => {
      useMixedAgentPair(engine, engine);

      it("admits an empty aggregate and keeps quota errors ahead of missing messages", () =>
        withEngineStoreAdmission(() => {
          const database = openOpenClawAgentDatabase({ agentId: "main" });
          const scope = {
            agentId: "main",
            storePath: database.path,
            sessionKey: "agent:main:reaction-quota",
            sessionId: "reaction-quota",
          };
          replaceSessionEntrySync(scope, { sessionId: scope.sessionId, updatedAt: 1 });
          const write = <T>(run: () => T) => runSqliteImmediateTransactionSync(database.db, run);
          write(() =>
            appendTranscriptEventsInTransaction(
              database,
              scope,
              [
                { type: "session", id: scope.sessionId, version: 3 },
                {
                  type: "message",
                  id: "message",
                  parentId: null,
                  message: { role: "assistant", content: "Synthetic answer" },
                },
              ],
              { scheduleProjectionReconcile: false },
            ),
          );
          const react = (messageId = "message") =>
            write(() =>
              setSessionReactionInDatabase(database, scope.sessionKey, {
                expectedSessionId: scope.sessionId,
                messageId,
                emoji: "👍",
                identityId: "reader",
              }),
            );
          expect(react()).toEqual({
            changed: true,
            newestRemainingEmoji: "👍",
            reactions: [{ emoji: "👍", count: 1, identities: [{ id: "reader" }] }],
          });
          write(() =>
            database.db
              .prepare(
                `WITH RECURSIVE readers(n) AS (
                  VALUES (1) UNION ALL SELECT n + 1 FROM readers WHERE n < 4999
                ) INSERT INTO session_reactions
                  (session_key, session_id, message_id, emoji, identity_id, created_at)
                  SELECT ?, ?, 'message', '👍', CAST(n AS TEXT), 1 FROM readers`,
              )
              .run(scope.sessionKey, scope.sessionId),
          );
          expect(() => react("missing")).toThrow(SessionReactionLimitError);
          write(() =>
            database.db
              .prepare("DELETE FROM session_reactions WHERE session_key = ? AND identity_id = '1'")
              .run(scope.sessionKey),
          );
          expect(() => react("missing")).toThrow(SessionReactionMessageMissingError);
          expect(
            database.db
              .prepare("SELECT COUNT(*) AS count FROM session_reactions WHERE session_key = ?")
              .get(scope.sessionKey),
          ).toEqual({ count: 4999 });
        }));
    },
  );
}
