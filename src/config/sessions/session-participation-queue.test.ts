import { expect, it } from "vitest";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { withSqliteDatabaseWriteScope } from "../../infra/sqlite-database-admission.js";
import { runOpenClawAgentWriteTransaction } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { upsertSessionEntryCore } from "./session-accessor.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import {
  addSessionMember,
  removeSessionMember,
  setSessionMemberAccess,
} from "./session-sharing-store.native.js";

it("retires exact persisted participant inputs atomically before downgrade/remove and re-invite", async () => {
  await withOpenClawTestState({ layout: "state-only" }, async ({ env }) => {
    const scope = { agentId: "main", env, sessionKey: "agent:main:participation" };
    await upsertSessionEntryCore(scope, { sessionId: "current", updatedAt: 1 });
    addSessionMember(scope, { identityId: "participant", addedBy: "creator", access: "send" });
    const seed = (suffix: string) =>
      runOpenClawAgentWriteTransaction((database) => {
        const db = getSessionKysely(database.db);
        for (const [name, sessionKey, sessionId, profileId] of [
          ["own", scope.sessionKey, "current", "participant"],
          ["foreign", scope.sessionKey, "current", "other"],
          ["incarnation", scope.sessionKey, "old", "participant"],
          ["sibling", "agent:main:sibling", "current", "participant"],
        ]) {
          const id = `${name}-${suffix}`;
          withSqliteDatabaseWriteScope(database.db, [sessionKey], () =>
            executeSqliteQuerySync(
              database.db,
              db.insertInto("session_pending_inputs").values({
                input_id: id,
                session_key: sessionKey,
                session_id: sessionId,
                idempotency_key: id,
                run_id: id,
                request_hash: id,
                lifecycle_generation: "generation",
                state: "queued",
                accepted_at: 1,
                message_json: JSON.stringify({
                  role: "user",
                  content: [],
                  __openclaw: { participationCeiling: { kind: "send", profileId, sessionKey } },
                }),
              }),
            ),
          );
        }
      }, scope);
    const read = () =>
      runOpenClawAgentWriteTransaction(
        (database) =>
          executeSqliteQuerySync(
            database.db,
            getSessionKysely(database.db)
              .selectFrom("session_pending_inputs")
              .select(["input_id", "state", "end_cause"])
              .orderBy("input_id"),
          ).rows,
        scope,
      );
    for (const operation of ["downgrade", "remove"] as const) {
      seed(operation);
      if (operation === "downgrade")
        setSessionMemberAccess(scope, { identityId: "participant", access: "read" });
      else removeSessionMember(scope, "participant");
      if (operation === "downgrade")
        setSessionMemberAccess(scope, { identityId: "participant", access: "send" });
      else
        addSessionMember(scope, { identityId: "participant", addedBy: "creator", access: "send" });
      for (const row of read()) {
        expect(row.state).toBe(row.input_id.startsWith("own-") ? "cancelled" : "queued");
        expect(row.end_cause).toBe(row.input_id.startsWith("own-") ? "revoked" : null);
      }
    }
  });
});
