import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  SessionActor,
  SessionActorAppendCommitted,
  SessionActorFactory,
  SessionActorHotState,
  SessionActorOperations,
} from "../config/sessions/session-actor-contract.js";
import { assertCanonicalSessionKeyWrite } from "../config/sessions/session-canonical-key.js";
import type { IncognitoSessionActor } from "../config/sessions/session-incognito-actor.js";
import type {
  IncognitoSessionAuthority,
  IncognitoSessionFacts,
} from "../config/sessions/session-incognito-contract.js";
import type { SqliteWorkerStore } from "../infra/sqlite-worker-contract.js";
import {
  createSqliteWorkerOperationAdmission,
  type SqliteWorkerAdmissionFactory,
  type SqliteWorkerOperationAdmission,
} from "../infra/sqlite-worker-operation-admission.js";
import { isIncognitoSessionKey } from "../shared/incognito-session-key.js";
import type { OpenClawAgentDatabaseOptions } from "./openclaw-agent-db-contract.js";
import type { AgentDatabaseIncognitoIdentity } from "./openclaw-agent-execution-identity.types.js";

type IncognitoActorWriteTokens = Map<
  string,
  { writeToken: string; dependencySessionIds: string[] }
>;

/** Revoke exact keys and shared transcript dependencies in the existing owner's replica. */
export function invalidateIncognitoSessionActorTokens(
  writeTokens: IncognitoActorWriteTokens,
  targets: readonly Pick<IncognitoSessionFacts, "sessionKey" | "sharing">[] | undefined,
): void {
  if (!targets) {
    writeTokens.clear();
    return;
  }
  const keys = new Set(targets.map((target) => target.sessionKey));
  const sessionIds = new Set(
    targets.flatMap((target) => {
      const sessionId = target.sharing?.entry?.sessionId;
      return [
        ...(sessionId ? [sessionId] : []),
        ...(writeTokens.get(target.sessionKey)?.dependencySessionIds ?? []),
      ];
    }),
  );
  for (const [key, held] of writeTokens) {
    if (keys.has(key) || held.dependencySessionIds.some((id) => sessionIds.has(id))) {
      writeTokens.delete(key);
    }
  }
}

/** The execution owner lends its queue, authority, and custody; this adapter owns no database. */
export function createIncognitoSessionActorFactory(params: {
  options: OpenClawAgentDatabaseOptions & { path: string };
  identity: AgentDatabaseIncognitoIdentity;
  assertBorrowed(this: void): void;
  assertReferenceCurrent(this: void): void;
  assertRetainedCurrent(this: void): void;
  retain<T>(this: void, operation: () => Promise<T>): Promise<T>;
  run<T>(
    this: void,
    authority: IncognitoSessionAuthority,
    operation: (scope: Pick<SqliteWorkerStore<SessionActorOperations>, "execute">) => Promise<T>,
    admission: SqliteWorkerAdmissionFactory,
  ): Promise<T>;
  writeTokens: IncognitoActorWriteTokens;
  sessionFacts: { invalidate(sessionKey: string): void };
  sessionActors: Set<SessionActor>;
  acquiredActors: Set<SessionActor>;
  getExecution(this: void): IncognitoSessionActor;
}): SessionActorFactory {
  const {
    options,
    identity,
    assertBorrowed,
    assertReferenceCurrent,
    assertRetainedCurrent,
    retain,
    run,
    writeTokens,
    sessionFacts,
    sessionActors,
    acquiredActors,
    getExecution,
  } = params;
  return {
    async acquire(requestedTarget, requestedLifetime) {
      assertBorrowed();
      requestedLifetime.assertAdmission?.();
      requestedLifetime.assertCurrent();
      const target = structuredClone(requestedTarget);
      if (!isDeepStrictEqual(target.database, identity)) {
        throw new Error("Incognito session actor target differs from its memory owner");
      }
      const { sessionKey } = target;
      assertCanonicalSessionKeyWrite(sessionKey, options.agentId);
      if (!isIncognitoSessionKey(sessionKey)) {
        throw new Error("Incognito actor requires an incognito session key");
      }
      const [{ createSessionActor }, { createSessionActorReplica }] = await Promise.all([
        import("../config/sessions/session-actor.js"),
        import("../config/sessions/session-actor-replica.js"),
      ]);
      assertBorrowed();
      requestedLifetime.assertAdmission?.();
      requestedLifetime.assertCurrent();
      const assertActorCurrent = () => {
        assertBorrowed();
        requestedLifetime.assertCurrent();
      };
      const assertActorReadable = () => {
        assertReferenceCurrent();
        requestedLifetime.assertReadable();
      };
      const lifetime = {
        assertCurrent: assertActorCurrent,
        assertReadable: assertActorCurrent,
      };
      const rememberToken = (state: SessionActorHotState) => {
        writeTokens.set(sessionKey, {
          writeToken: state.writeToken,
          dependencySessionIds: state.dependencySessionIds,
        });
      };
      const actor = createSessionActor({
        target,
        lifetime: {
          assertAdmission: () => requestedLifetime.assertAdmission?.(),
          assertCurrent: assertActorCurrent,
          assertReadable: assertActorReadable,
        },
        replica: createSessionActorReplica({
          target: { sessionKey, database: identity },
          lifetime,
          currentWriteToken: () => writeTokens.get(sessionKey)?.writeToken,
        }),
        transport: {
          retain,
          run: (operation, authorize) =>
            run(
              { assertCurrent: assertActorCurrent },
              (scope) =>
                operation({
                  captureGeneration: () => ({ assertCurrent: assertRetainedCurrent }),
                  async execute(command) {
                    try {
                      const result = await scope.execute(command);
                      if ("writeToken" in result) {
                        rememberToken(result);
                      } else if (result.kind === "committed") {
                        sessionFacts.invalidate(sessionKey);
                        rememberToken(result.receipt.postimage);
                      } else if (result.kind === "stale-version") {
                        rememberToken(result.postimage);
                      } else if (result.kind === "unknown") {
                        writeTokens.delete(sessionKey);
                        sessionFacts.invalidate(sessionKey);
                      }
                      return result;
                    } catch (error) {
                      const pendingToken = writeTokens.get(sessionKey);
                      if (command.type !== "session.actor.read") {
                        sessionFacts.invalidate(sessionKey);
                      }
                      // The facade decides commit versus unknown from native evidence.
                      // A lost ordinary reply cannot erase the final grant's token.
                      if (pendingToken) {
                        writeTokens.set(sessionKey, pendingToken);
                      }
                      throw error;
                    }
                  },
                }),
              (retained) => {
                const native: SqliteWorkerOperationAdmission = createSqliteWorkerOperationAdmission(
                  (request, grant) => {
                    assertActorCurrent();
                    if (
                      !isRecord(request.facts) ||
                      !isDeepStrictEqual(request.facts.identity, identity)
                    ) {
                      throw new Error("Incognito actor command changed its admitted owner");
                    }
                    const facts =
                      request.stage === "prepare" ? request.facts : request.facts.publication;
                    authorize({ ...request, facts }, { admission: native, retained }, grant);
                    if (
                      request.stage === "commit" &&
                      isRecord(facts) &&
                      facts.kind === "session-actor-admission" &&
                      facts.final === true
                    ) {
                      // Legacy live claims remain usable by this command's final grant;
                      // fence their projection before the native commit can be observed.
                      sessionFacts.invalidate(sessionKey);
                      if (
                        isRecord(facts.snapshot) &&
                        typeof facts.snapshot.writeToken === "string" &&
                        Array.isArray(facts.snapshot.dependencySessionIds) &&
                        facts.snapshot.dependencySessionIds.every((id) => typeof id === "string")
                      ) {
                        writeTokens.set(sessionKey, {
                          writeToken: facts.snapshot.writeToken,
                          dependencySessionIds: facts.snapshot.dependencySessionIds,
                        });
                      }
                    }
                  },
                );
                return { nativeLocations: [], admission: native };
              },
            ),
          async afterCommitted(outcome) {
            const execution = getExecution();
            if (!outcome.receipt.transcript.projectionNeedsReconcile) {
              return undefined;
            }
            const entry = outcome.receipt.postimage.entry;
            if (!entry) {
              throw new Error("Committed incognito projection lost its session");
            }
            const { reconcileSessionTranscriptIndexes } =
              await import("../config/sessions/session-transcript-reconcile.js");
            // Phase commits invalidate legacy claims; reconciliation acquires its own
            // current claim from the same memory owner before opening a compute scope.
            await execution.sessions.read(
              { assertCurrent: assertActorCurrent },
              {
                sessionKey,
                expected: {
                  sessionId: entry.sessionId,
                  lifecycleRevision: entry.lifecycleRevision,
                },
              },
            );
            await reconcileSessionTranscriptIndexes(
              { ...options, preferredSessionId: entry.sessionId },
              {
                actor: execution,
                authority: { assertCurrent: assertActorCurrent },
                target: {
                  sessionKey,
                  sessionId: entry.sessionId,
                  lifecycleRevision: entry.lifecycleRevision,
                },
              },
            );
            const markReady = (append: SessionActorAppendCommitted) => {
              append.value.projectionNeedsReconcile = false;
              if (append.header) {
                append.header.projectionNeedsReconcile = false;
              }
            };
            const value = outcome.value;
            if (value && "kind" in value) {
              if (value.kind === "session-turn") {
                value.projectionNeedsReconcile = false;
              } else if (value.kind === "metadata" || value.kind === "message") {
                markReady(value);
              }
            } else if (value && "inputId" in value) {
              if (value.append) {
                markReady(value.append);
              }
              if (value.turn) {
                value.turn.projectionNeedsReconcile = false;
              }
            } else if (value && "projectionNeedsReconcile" in value) {
              value.projectionNeedsReconcile = false;
            }
            return { value };
          },
          async release() {},
        },
      });
      const shared: SessionActor = {
        ...actor,
        async release() {
          await actor.release();
          acquiredActors.delete(shared);
          sessionActors.delete(shared);
          if (![...sessionActors].some((candidate) => candidate.target.sessionKey === sessionKey)) {
            writeTokens.delete(sessionKey);
          }
        },
      };
      acquiredActors.add(shared);
      sessionActors.add(shared);
      return shared;
    },
  };
}
