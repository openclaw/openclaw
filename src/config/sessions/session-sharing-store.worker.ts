import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { createSqliteCommitReceipt } from "../../infra/sqlite-commit-receipt.js";
import { withSqlitePostCommitPublications } from "../../infra/sqlite-post-commit.js";
import {
  assertTransactionUsable,
  runSqliteDeferredTransactionSync,
  runSqliteWorkerTransactionSync,
} from "../../infra/sqlite-transaction.js";
import type { SqliteWorkerBackend } from "../../infra/sqlite-worker-contract.js";
import type { SqliteWorkerDatabaseContext } from "../../infra/sqlite-worker-database-context.js";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import { deferSqliteWorkerCommitReceipt } from "../../infra/sqlite-worker-operation-admission.js";
import { captureSessionRowChanges } from "../../sessions/session-row-changes.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import {
  getOpenClawAgentDatabaseIfOpen,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import type { AgentDatabaseAdmissionRestriction } from "../../state/openclaw-agent-execution-domain.js";
import { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS } from "../../state/openclaw-state-db-contract.js";
import type { SessionAccessScope } from "./session-accessor.sqlite-contract.js";
import { updatePreparedSessionProfileInvolvement } from "./session-accessor.sqlite-involvement.js";
import { assignSessionOwner } from "./session-accessor.sqlite-owner.js";
import { readSqliteSessionParticipantProjection } from "./session-accessor.sqlite-participant-projection.js";
import { recordSessionParticipantFromWorker } from "./session-accessor.sqlite-participants.native.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import { applySessionGroupCategoryMutation } from "./session-group-categories.kernel.js";
import { readSessionGroupCategoryKeys } from "./session-group-categories.read.js";
import { addSessionMember, removeSessionMember } from "./session-sharing-store.native.js";
import type {
  MembershipPublication,
  SessionCollaborationFact,
  SessionSharingWorkerOperations,
  SessionSharingCommitReceipt,
} from "./session-sharing-store.types.js";
import {
  addSessionSuggestionInDatabase,
  claimSessionSuggestionDispatchInDatabase,
  finalizeSessionSuggestionClaimInDatabase,
  releaseSessionSuggestionDispatchInDatabase,
} from "./session-suggestion-store.kernel.js";
export type { SessionSharingWorkerOperations } from "./session-sharing-store.types.js";

/** The canonical agent executor retains the connection and both live admission checks. */
export function bindSqliteWorkerBackend(
  _input: undefined,
  context: Omit<SqliteWorkerDatabaseContext, "admit"> & {
    admit(stage: "transaction" | "commit", restriction?: AgentDatabaseAdmissionRestriction): void;
  },
): SqliteWorkerBackend<SessionSharingWorkerOperations> {
  const db = context.database;
  const source = readOpenClawAgentDatabaseIdentity({ db });
  let categoryPlan:
    | {
        from: string;
        storePath: string;
        keys: string[];
      }
    | undefined;
  const workerDatabase = (scope: SessionAccessScope) => {
    const database = getOpenClawAgentDatabaseIfOpen(toDatabaseOptions(resolveSqliteScope(scope)));
    if (!database || database.db !== db || database.path !== context.databasePath) {
      throw new Error("Session collaboration write lost its physical store owner");
    }
    return database;
  };
  return {
    execute(command) {
      const scope = { ...command.input.scope };
      const target = resolveOpenClawAgentSqlitePath(toDatabaseOptions(resolveSqliteScope(scope)));
      const sameOwner = db.location()
        ? readDatabasePathIdentitySync(target).canonicalPath === context.databasePath
        : target === context.databasePath &&
          getOpenClawAgentDatabaseIfOpen(toDatabaseOptions(resolveSqliteScope(scope)))?.db === db;
      if (!sameOwner) {
        throw new Error("Session collaboration target changed its database owner");
      }
      scope.storePath = context.databasePath;
      if (command.type === "category.prepare") {
        const database = workerDatabase(scope);
        return withSqlitePostCommitPublications(db, () =>
          runSqliteDeferredTransactionSync(db, () => {
            categoryPlan = {
              from: command.input.from,
              storePath: database.path,
              keys: readSessionGroupCategoryKeys(database, command.input.from),
            };
            return categoryPlan.keys;
          }),
        );
      }
      let candidate: SessionSharingCommitReceipt | undefined;
      let keys = [scope.sessionKey];
      let participantResult: SessionSharingWorkerOperations["participant"]["output"] | undefined;
      let membershipResult: MembershipPublication | undefined;
      let ownerResult: SessionSharingWorkerOperations["owner.assign"]["output"] | undefined;
      return withSqlitePostCommitPublications(db, () =>
        runSqliteWorkerTransactionSync(
          {
            ...context,
            admit(stage) {
              context.admit(
                stage,
                stage === "commit" && typeof source.identity === "string"
                  ? (request, dispatch) => {
                      if (!candidate || !isRecord(request.facts)) {
                        throw new Error("Session collaboration commit omitted its candidate");
                      }
                      dispatch({ ...request, facts: { ...request.facts, publication: candidate } });
                    }
                  : undefined,
              );
            },
          },
          () => {
            const captured = captureSessionRowChanges(db, () => {
              if (command.type === "involvement") {
                return updatePreparedSessionProfileInvolvement(
                  scope,
                  command.input.params,
                  command.input.profiles,
                );
              }
              if (command.type === "owner.assign") {
                ownerResult = { value: assignSessionOwner(scope, command.input.params) };
                return ownerResult;
              }
              if (command.type === "suggestion.add") {
                const database = workerDatabase(scope);
                return addSessionSuggestionInDatabase(
                  database,
                  scope.sessionKey,
                  command.input.params,
                  {
                    agentId: database.agentId,
                    path: database.path,
                    env: scope.env,
                  },
                );
              }
              if (command.type === "suggestion.claim") {
                const database = workerDatabase(scope);
                return claimSessionSuggestionDispatchInDatabase(
                  database,
                  scope.sessionKey,
                  command.input.params,
                  {
                    agentId: database.agentId,
                    path: database.path,
                    env: scope.env,
                  },
                );
              }
              if (command.type === "suggestion.release") {
                const database = workerDatabase(scope);
                return releaseSessionSuggestionDispatchInDatabase(
                  database,
                  scope.sessionKey,
                  command.input.params,
                  {
                    agentId: database.agentId,
                    path: database.path,
                    env: scope.env,
                  },
                );
              }
              if (command.type === "suggestion.finalize") {
                const database = workerDatabase(scope);
                return finalizeSessionSuggestionClaimInDatabase(
                  database,
                  scope.sessionKey,
                  command.input.params,
                  {
                    agentId: database.agentId,
                    path: database.path,
                    env: scope.env,
                  },
                );
              }
              if (command.type === "category.apply") {
                const database = workerDatabase(scope);
                if (
                  !categoryPlan ||
                  categoryPlan.from !== command.input.from ||
                  categoryPlan.storePath !== database.path
                ) {
                  throw new Error("Session group category mutation has no matching prepared rows");
                }
                keys = categoryPlan.keys;
                return applySessionGroupCategoryMutation(
                  database,
                  categoryPlan.keys,
                  command.input.from,
                  command.input.to,
                  scope.env ?? process.env,
                );
              }
              if (command.type === "participant") {
                const value = recordSessionParticipantFromWorker(
                  workerDatabase(scope),
                  scope,
                  command.input.params,
                );
                participantResult = {
                  value,
                  projectionChanged: false,
                  participants: readSqliteSessionParticipantProjection(db, scope.sessionKey),
                };
                return participantResult;
              }
              if (command.type === "add") {
                const value = addSessionMember(scope, command.input.params);
                const result: SessionSharingWorkerOperations["add"]["output"] = { value };
                membershipResult = result;
                return result;
              }
              const value = removeSessionMember(
                scope,
                command.input.identityId,
                command.input.expected,
                command.input.expectedSessionId,
                command.input.expectedEntry,
              );
              const result: SessionSharingWorkerOperations["remove"]["output"] = { value };
              membershipResult = result;
              return result;
            });
            const factsByKey = new Map<string, SessionCollaborationFact[]>();
            const recordFact = (sessionKey: string, facts: SessionCollaborationFact) => {
              const current = factsByKey.get(sessionKey) ?? [];
              current.push(facts);
              factsByKey.set(sessionKey, current);
            };
            for (const change of captured.changes) {
              if (!("sessionKey" in change) || !change.facts) {
                continue;
              }
              const facts = change.facts;
              if (membershipResult && facts.kind === "member") {
                membershipResult.facts = facts;
                recordFact(change.sessionKey, facts);
              } else if (ownerResult && facts.kind === "owner") {
                ownerResult.facts = facts;
                recordFact(change.sessionKey, facts);
              } else if (participantResult && facts.kind === "participants") {
                participantResult.projectionChanged = true;
                recordFact(change.sessionKey, {
                  ...facts,
                  projection: participantResult.participants,
                });
              } else if (command.type === "category.apply" && facts.kind === "entry") {
                recordFact(change.sessionKey, {
                  kind: "category",
                  sessionId: facts.sessionId,
                  category: facts.category,
                });
              } else if (command.type === "involvement" && facts.kind === "entry") {
                recordFact(change.sessionKey, { kind: "unchanged" });
              }
            }
            // Incognito's actor supplies its own receipt and session authority.
            if (typeof source.identity === "string") {
              const publication = createSqliteCommitReceipt<
                readonly SessionCollaborationFact[],
                typeof source
              >({
                source,
                domain: "session-collaboration",
                keys,
                readFact: (key) => {
                  const current = factsByKey.get(key);
                  return current && current.length > 0
                    ? { kind: "postimage", value: current }
                    : { kind: "unchanged" };
                },
              });
              candidate = {
                kind: "session-collaboration-committed",
                type: command.type,
                result: captured.result,
                publication,
              };
              deferSqliteWorkerCommitReceipt(db, candidate);
            }
            return captured.result;
          },
          {
            operationLabel: `sessions.${command.type}`,
            busyTimeoutMs: OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
            databaseLabel: context.databasePath,
          },
        ),
      );
    },
    assertSettled() {
      assertTransactionUsable(db);
      if (db.isTransaction) {
        throw new Error("Session collaboration transaction did not settle");
      }
    },
    close() {},
  };
}
