import { expect, it } from "vitest";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { withSqliteDatabaseWriteScope } from "../../infra/sqlite-database-admission.js";
import {
  closeOpenClawAgentDatabasesAsync,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { captureRuntimeConfigAsyncReader } from "../io.runtime.js";
import { upsertSessionEntryCore } from "./session-accessor.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import * as sharingWorker from "./session-sharing-store.js";
import {
  addSessionMember,
  removeSessionMember,
  setSessionMemberAccess,
} from "./session-sharing-store.native.js";

it.each(["native", "worker"] as const)(
  "%s retires persisted participant custody only on commit before re-invite",
  async (writer) => {
    await withOpenClawTestState({ layout: "state-only" }, async ({ env }) => {
      await captureRuntimeConfigAsyncReader()();
      const scope = { agentId: "main", env, sessionKey: "agent:main:participation" };
      await upsertSessionEntryCore(scope, { sessionId: "old", updatedAt: 1 });
      await upsertSessionEntryCore(scope, { sessionId: "current", updatedAt: 2 });
      await upsertSessionEntryCore(
        { ...scope, sessionKey: "agent:main:sibling" },
        { sessionId: "sibling", updatedAt: 1 },
      );
      const childKey = "agent:main:subagent:participant-child";
      await upsertSessionEntryCore(
        { ...scope, sessionKey: childKey },
        { sessionId: "child", updatedAt: 1 },
      );
      addSessionMember(scope, { identityId: "participant", addedBy: "creator", access: "send" });
      const seed = (suffix: string) =>
        runOpenClawAgentWriteTransaction((database) => {
          const db = getSessionKysely(database.db);
          for (const [name, sessionKey, sessionId, profileId] of [
            ["own", scope.sessionKey, "current", "participant"],
            ["foreign", scope.sessionKey, "current", "other"],
            ["incarnation", scope.sessionKey, "old", "participant"],
            ["sibling", "agent:main:sibling", "sibling", "participant"],
            ["child", childKey, "child", "participant"],
            ["child-foreign", childKey, "child", "other"],
          ] as const) {
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
                  message_json: JSON.stringify({ role: "user", content: [] }),
                  origin_source_json: JSON.stringify({
                    kind: "gateway",
                    snapshot: {
                      version: 2,
                      profileId,
                      scopes: ["operator.sessions.read"],
                      assignedRole: "invited",
                      githubLogin: null,
                      grant: null,
                      aliasBindingIds: [],
                      authPolicy: {
                        generation: "",
                        grantGeneration: "fixture",
                        role: "operator",
                        authMethod: "token",
                      },
                      sourceIngress: "control-ui",
                      controlUiAdmin: false,
                      localOperator: false,
                      participationCeiling: {
                        kind: "send",
                        profileId,
                        sessionKey: sessionKey === childKey ? scope.sessionKey : sessionKey,
                        tools: ["read"],
                        permission: "workspace",
                        source: {
                          agentId: "main",
                          sessionId: sessionKey === childKey ? "current" : sessionId,
                          lifecycleRevision: null,
                          creatorProfileId: "creator",
                          root: "/synthetic/root",
                        },
                      },
                    },
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
                .select(["input_id", "state", "end_cause", "message_json"])
                .orderBy("input_id"),
            ).rows,
          scope,
        );
      for (const operation of ["downgrade", "remove"] as const) {
        seed(operation);
        expect(() =>
          runOpenClawAgentWriteTransaction(() => {
            if (operation === "downgrade") {
              setSessionMemberAccess(scope, { identityId: "participant", access: "read" });
            } else {
              removeSessionMember(scope, "participant");
            }
            throw new Error("rollback reduction");
          }, scope),
        ).toThrow("rollback reduction");
        if (operation === "downgrade") {
          await (
            writer === "worker" ? sharingWorker.setSessionMemberAccess : setSessionMemberAccess
          )(scope, { identityId: "participant", access: "read" });
        } else {
          await (writer === "worker" ? sharingWorker.removeSessionMember : removeSessionMember)(
            scope,
            "participant",
          );
        }
        if (operation === "downgrade") {
          setSessionMemberAccess(scope, { identityId: "participant", access: "send" });
        } else {
          addSessionMember(scope, {
            identityId: "participant",
            addedBy: "creator",
            access: "send",
          });
        }
        await closeOpenClawAgentDatabasesAsync();
        for (const row of read()) {
          const retired =
            row.input_id.startsWith("own-") || /^child-(downgrade|remove)$/.test(row.input_id);
          expect(row.state).toBe(retired ? "cancelled" : "queued");
          expect(row.end_cause).toBe(retired ? "revoked" : null);
          expect(JSON.parse(row.message_json)["__openclaw"]?.participationRevoked).toBe(
            retired || undefined,
          );
        }
      }
    });
  },
);
