import { describe, expect, it } from "vitest";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.sqlite-entry.js";
import { recordSessionParticipant } from "../../config/sessions/session-accessor.sqlite-participants.native.js";
import { MAX_SESSION_PARTICIPANTS } from "../../config/sessions/session-entry-provenance.js";
import { participantIdentityNamespace } from "../../config/sessions/session-participant-identity.js";
import { onSessionLifecycleEvent } from "../../sessions/session-lifecycle-events.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { ensureSessionParticipantsSchema } from "../../state/openclaw-agent-session-participants-schema.js";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import { linkEmail } from "../../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { runSqliteImmediateTransactionSync } from "../sqlite-transaction.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import { mixedAgentConnection, useMixedAgentPair } from "./mixed-agent.conformance.test-support.js";

for (const engine of ["sqlite", "postgres"] as const) {
  describe.skipIf(engine === "postgres" && !mixedAgentConnection)(
    `${engine} participant capacity`,
    () => {
      useMixedAgentPair(engine, engine);

      it("admits the last slot, rejects an absent identity without publication, and updates at capacity", () =>
        withEngineStoreAdmission(() => {
          const database = openOpenClawAgentDatabase({ agentId: "main" });
          const scope = {
            agentId: "main",
            storePath: database.path,
            sessionKey: "agent:main:participant-capacity",
          };
          replaceSessionEntrySync(scope, { sessionId: "participant-capacity", updatedAt: 1 });
          const identity = { type: "agent", id: "last" } as const;
          const namespace = participantIdentityNamespace(identity);
          runSqliteImmediateTransactionSync(database.db, () => {
            ensureSessionParticipantsSchema(database.db);
            const insert = database.db.prepare(
              "INSERT INTO session_participants (session_key, identity_namespace, actor_id, contribution_count, first_prompted_at, last_prompted_at) VALUES (?, ?, ?, 1, NULL, NULL)",
            );
            for (let i = 0; i < MAX_SESSION_PARTICIPANTS - 1; i++) {
              insert.run(scope.sessionKey, namespace, `seed-${i}`);
            }
          });
          expect(recordSessionParticipant(scope, { identity, promptedAt: 10 })).toBe("inserted");
          const rows = () =>
            database.db
              .prepare("SELECT * FROM session_participants WHERE session_key = ? ORDER BY actor_id")
              .all(scope.sessionKey);
          const before = rows();
          const events: string[] = [];
          const unsubscribe = onSessionLifecycleEvent((event) => {
            if (event.sessionKey === scope.sessionKey) {
              events.push(event.reason);
            }
          });
          try {
            expect(
              recordSessionParticipant(scope, {
                identity: { type: "agent", id: "overflow" },
                promptedAt: 20,
              }),
            ).toBe("capped");
            expect(rows()).toEqual(before);
            expect(events).toEqual([]);
            expect(recordSessionParticipant(scope, { identity, promptedAt: 30 })).toBe("updated");
            expect(events).toEqual(["participants"]);
            expect(
              database.db
                .prepare(
                  "SELECT contribution_count, first_prompted_at, last_prompted_at FROM session_participants WHERE session_key = ? AND actor_id = ?",
                )
                .get(scope.sessionKey, identity.id),
            ).toEqual({ contribution_count: 2, first_prompted_at: 10, last_prompted_at: 30 });
          } finally {
            unsubscribe();
          }
        }));

      it("updates a retained profile alias at capacity without creating its canonical row", async () => {
        const old = withEngineStoreAdmission(() => ensureProfileForEmail("old@example.test"));
        const current = withEngineStoreAdmission(() =>
          ensureProfileForEmail("current@example.test"),
        );
        using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
        withEngineStoreAdmission(() => {
          const database = openOpenClawAgentDatabase({ agentId: "main" });
          const scope = {
            agentId: "main",
            storePath: database.path,
            sessionKey: "agent:main:participant-alias",
          };
          replaceSessionEntrySync(scope, { sessionId: "participant-alias", updatedAt: 1 });
          expect(
            recordSessionParticipant(scope, {
              identity: { type: "profile", id: old.id },
              promptedAt: 10,
            }),
          ).toBe("inserted");
          for (let i = 1; i < MAX_SESSION_PARTICIPANTS; i++) {
            recordSessionParticipant(scope, {
              identity: { type: "agent", id: `seed-${i}` },
              promptedAt: 10,
            });
          }
          linkEmail("old@example.test", current.id);
          expect(
            recordSessionParticipant(scope, {
              identity: { type: "profile", id: current.id },
              promptedAt: 20,
            }),
          ).toBe("updated");
          expect(
            database.db
              .prepare(
                "SELECT actor_id, contribution_count FROM session_participants WHERE session_key = ? AND identity_namespace = ?",
              )
              .all(
                scope.sessionKey,
                participantIdentityNamespace({ type: "profile", id: current.id }),
              ),
          ).toEqual([{ actor_id: old.id, contribution_count: 2 }]);
        });
      });
    },
  );
}
