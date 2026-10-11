import { isDeepStrictEqual } from "node:util";
import {
  collectNestedErrorCandidates,
  extractErrorCode,
} from "@openclaw/normalization-core/error-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { withSqliteCommittedPublications } from "../../infra/sqlite-post-commit.js";
import { SqliteWorkerError, type SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";
import { observeSqliteWorkerCommittedFacts } from "../../infra/sqlite-worker-operation-admission.js";
import type { RetainedWorkerTransactionAdmission } from "../../infra/sqlite-worker-operation-settlement.js";
import type { SqliteWorkerStore } from "../../infra/sqlite-worker-store.js";
import { emitSessionLifecycleEvent } from "../../sessions/session-lifecycle-events.js";
import { sessionChanges, type SessionRowChange } from "../../sessions/session-row-changes.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import {
  withOpenClawAgentDatabaseRuntime,
  deferOpenClawAgentPostCommitPublication,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import {
  isIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.paths.js";
import { captureOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import { openOpenClawAgentSqliteWorkerStore } from "../../state/openclaw-agent-worker-store.js";
import { runOpenClawAgentWriteAdmission } from "../../state/openclaw-agent-write-admission.js";
import { readResidentUserProfileAliases } from "../../state/user-profile-list.js";
import { cloneEnvWithPlatformSemantics } from "../config-env-vars.js";
import { resolveStateDir } from "../state-dir.js";
import type { SessionAccessScope } from "./session-accessor.sqlite-contract.js";
import { bindSessionEntryPublicationSource } from "./session-accessor.sqlite-entry-cache-publication.js";
import { publishSessionSharingMemberChange } from "./session-accessor.sqlite-entry-cache.js";
import { retainSessionEntryWorkerPublication } from "./session-accessor.sqlite-entry-worker-publication.js";
import { recordSessionParticipant } from "./session-accessor.sqlite-participants.native.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import type { SessionActorMemoryCollaborationCommand } from "./session-actor-memory-collaboration-contract.js";
import { getSessionActorStorageBinding } from "./session-actor-storage-binding.js";
import type { SessionCollaborationScope } from "./session-collaboration-scope.js";
import { captureIncognitoSessionOperation } from "./session-incognito-binding.js";
import type { IncognitoSessionAuthority } from "./session-incognito-contract.js";
import type { IncognitoSideDataOperations } from "./session-incognito-side-data-contract.js";
import { addSessionMember, removeSessionMember } from "./session-sharing-store.native.js";
import { readSessionCollaborationCandidate } from "./session-sharing-store.receipt.js";
import type {
  MembershipPublication,
  SessionCollaborationMutation,
  SessionSharingWorkerOperations,
  SessionSharingCommitReceipt,
} from "./session-sharing-store.types.js";

function toIncognitoCollaborationCommand(
  command: SqliteWorkerCommand<SessionSharingWorkerOperations>,
  sessionKey: string,
): SqliteWorkerCommand<
  Pick<IncognitoSideDataOperations, `session.sharing.${SessionCollaborationMutation}`>
> {
  switch (command.type) {
    case "add":
      return { type: "session.sharing.add", input: { sessionKey, params: command.input.params } };
    case "remove": {
      const { scope: _scope, ...input } = command.input;
      return { type: "session.sharing.remove", input: { ...input, sessionKey } };
    }
    case "participant":
      return {
        type: "session.sharing.participant",
        input: { sessionKey, params: command.input.params },
      };
    case "owner.assign":
      return {
        type: "session.sharing.owner.assign",
        input: { sessionKey, params: command.input.params },
      };
    case "suggestion.add":
      return {
        type: "session.sharing.suggestion.add",
        input: { sessionKey, params: command.input.params },
      };
    case "suggestion.claim":
      return {
        type: "session.sharing.suggestion.claim",
        input: { sessionKey, params: command.input.params },
      };
    case "suggestion.release":
      return {
        type: "session.sharing.suggestion.release",
        input: { sessionKey, params: command.input.params },
      };
    case "suggestion.finalize":
      return {
        type: "session.sharing.suggestion.finalize",
        input: { sessionKey, params: command.input.params },
      };
    case "category.prepare":
    case "category.apply":
    case "involvement":
      break;
  }
  throw new Error("Incognito collaboration command requires its dedicated owner");
}

export async function runSessionCollaborationWrite<
  Key extends keyof SessionSharingWorkerOperations,
  T,
>(
  scope: SessionCollaborationScope,
  command: {
    type: Key;
    input: SessionSharingWorkerOperations[Key]["input"];
  } & SqliteWorkerCommand<SessionSharingWorkerOperations>,
  native: (scope: SessionAccessScope) => T,
  publish: (
    result: SessionSharingWorkerOperations[Key]["output"],
    location: { agentId: string; storePath: string; sessionKey: string },
    database: OpenClawAgentDatabase | undefined,
    currentKeys?: ReadonlySet<string>,
  ) => T,
  assertCurrent: () => void = () => undefined,
  prepare?: (
    operation: Pick<SqliteWorkerStore<SessionSharingWorkerOperations>, "execute">,
    scope: SessionAccessScope,
  ) => Promise<void | SessionSharingWorkerOperations[Key]["input"]>,
): Promise<T> {
  const memory = getSessionActorStorageBinding(scope);
  if (memory) {
    if (command.type === "category.prepare" || command.type === "category.apply") {
      throw new Error("Memory categories require the category owner composition");
    }
    const { scope: _scope, ...input } = command.input;
    const profileAliases =
      command.type === "participant" && command.input.params.identity.type === "profile"
        ? [...readResidentUserProfileAliases(command.input.params.identity.id, { env: scope.env })]
        : undefined;
    // The discriminant retains the existing collaboration input/result pair.
    const actorCommand = {
      type: `session.collaboration.${command.type}`,
      input: { ...input, ...(profileAliases ? { profileAliases } : {}) },
    } as SessionActorMemoryCollaborationCommand;
    let value: T | undefined;
    const outcome = await memory.actor.storage!.mutate(
      actorCommand,
      {
        assertCurrent: () => {
          assertCurrent();
          memory.authority.assertCurrent();
        },
        authorize: (stage, facts, publication) =>
          memory.authority.authorize(stage, facts, publication),
      },
      {
        committed(result) {
          value = publish(
            result.value as SessionSharingWorkerOperations[Key]["output"],
            {
              agentId: memory.agentId,
              storePath: memory.path,
              sessionKey: memory.actor.target.sessionKey,
            },
            undefined,
          );
        },
      },
    );
    if (outcome.kind === "rolled-back" || outcome.failure) {
      const failure = outcome.kind === "rolled-back" ? outcome.error : outcome.failure!;
      const error = new Error(failure.message);
      error.name = failure.name;
      throw error;
    }
    return value!;
  }
  const resolved = resolveSqliteScope(scope);
  const resolvedOptions = toDatabaseOptions(resolved);
  const env = cloneEnvWithPlatformSemantics(resolved.env ?? process.env);
  env.OPENCLAW_STATE_DIR = resolveStateDir(env);
  const options = {
    ...resolvedOptions,
    env,
    path: resolveOpenClawAgentSqlitePath({ ...resolvedOptions, env }),
  };
  const location = {
    agentId: resolved.agentId,
    storePath: options.path,
    sessionKey: resolved.sessionKey,
  };
  const capturedScope = { ...location, env };
  const incognito = scope.incognito ?? captureIncognitoSessionOperation(scope);
  if (incognito) {
    const { actor, authority } = incognito;
    if (actor.agentId !== location.agentId || actor.path !== location.storePath) {
      throw new Error("Collaboration target differs from its captured incognito actor");
    }
    if (command.type === "category.prepare" || command.type === "category.apply") {
      throw new Error("Incognito categories require the category owner composition");
    }
    const currentAuthority: IncognitoSessionAuthority = {
      assertCurrent() {
        assertCurrent();
        authority.assertCurrent();
        actor.assertCurrent();
      },
      authorize: (stage, facts) => authority.authorize?.(stage, facts),
    };
    currentAuthority.assertCurrent();
    if (command.type === "involvement") {
      return publish(
        // SAFETY: This discriminant's native incognito contract is the same non-mutating refusal.
        { accepted: false, changed: false } as SessionSharingWorkerOperations[Key]["output"],
        location,
        undefined,
      );
    }
    const actorCommand = toIncognitoCollaborationCommand(command, location.sessionKey);
    let published = false;
    const invalidate = () => {
      if (!published && !command.type.startsWith("suggestion.")) {
        sessionChanges.emit({ ...location, factsInvalidated: true });
        published = true;
      }
    };
    try {
      let value!: T;
      await actor.sessions.sideData(
        currentAuthority,
        actorCommand,
        undefined,
        (result) => {
          value = publish(
            // SAFETY: The mapped actor command retains the original Key's input/output pair.
            result as SessionSharingWorkerOperations[Key]["output"],
            location,
            undefined,
          );
          published = true;
        },
        invalidate,
      );
      return value;
    } catch (error) {
      invalidate();
      throw error;
    }
  }
  if (isIncognitoOpenClawAgentSqlitePath(options.path, options)) {
    // Process-held databases cannot be reopened in a Worker; retain their sole native owner.
    return runOpenClawAgentWriteAdmission(
      options,
      () => {
        assertCurrent();
        return native(capturedScope);
      },
      true,
    );
  }
  const execution = captureOpenClawAgentDatabaseExecution(options);
  const assertQueuedCurrent = () => {
    execution.assertCurrent();
    assertCurrent();
  };
  const commandScope = {
    agentId: resolved.agentId,
    sessionKey: resolved.sessionKey,
    storePath: options.path,
    env: { OPENCLAW_STATE_DIR: env.OPENCLAW_STATE_DIR },
  };
  const capturedCommand: { type: Key; input: SessionSharingWorkerOperations[Key]["input"] } = {
    type: command.type,
    input: structuredClone({ ...command.input, scope: commandScope }),
  };
  try {
    return await runOpenClawAgentWriteAdmission(
      options,
      () =>
        withOpenClawAgentDatabaseRuntime(
          options,
          async (database) => {
            const { db } = database;
            assertQueuedCurrent();
            const identity = readOpenClawAgentDatabaseIdentity(database).identity;
            if (typeof identity !== "string") {
              throw new Error("Session collaboration worker requires a file-backed owner");
            }
            const publication = retainSessionEntryWorkerPublication({
              ...location,
              databaseIdentity: identity,
            });
            let publicationKeys = [location.sessionKey];
            let mutationDispatched = false;
            let resultReceived = false;
            let receiptFailed = false;
            const publicationState: { result?: { value: T } } = {};
            let activeAdmission: RetainedWorkerTransactionAdmission | undefined;
            let mutationAdmission: typeof activeAdmission;
            let candidate: SessionSharingCommitReceipt | undefined;
            const worker = await openOpenClawAgentSqliteWorkerStore<SessionSharingWorkerOperations>(
              options,
              db,
              {
                moduleUrl: resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.sessionSharingStore),
                input: undefined,
                assertAdmission(request) {
                  if (mutationDispatched && request.stage === "commit") {
                    if (!isRecord(request.facts)) {
                      throw new SqliteWorkerError(
                        "Session collaboration commit omitted its candidate",
                        "outcome-unknown",
                      );
                    }
                    candidate = structuredClone(
                      readSessionCollaborationCandidate(
                        request.facts.publication,
                        // SAFETY: Serialization and typed preparation preserve the command's input/discriminant pairing.
                        capturedCommand as SqliteWorkerCommand<SessionSharingWorkerOperations>,
                        publicationKeys,
                        identity,
                      ),
                    );
                  }
                  return request;
                },
                onAdmitted(request) {
                  if (mutationDispatched && request.stage === "commit") {
                    mutationAdmission = activeAdmission;
                    if (!capturedCommand.type.startsWith("suggestion.")) {
                      const memberships = new Map<string, string>();
                      for (const [key, fact] of candidate?.publication.facts ?? []) {
                        if (fact.kind === "postimage" && fact.value[0]?.kind === "member") {
                          memberships.set(key, fact.value[0].sessionId);
                        }
                      }
                      publication.beginChanges(publicationKeys, memberships);
                    }
                  }
                },
                observeAdmission(admission, retained) {
                  activeAdmission = retained;
                  observeSqliteWorkerCommittedFacts(admission, ({ facts }) => {
                    if (!mutationDispatched || publicationState.result) {
                      return;
                    }
                    try {
                      if (!candidate || !isDeepStrictEqual(facts, candidate)) {
                        throw new SqliteWorkerError(
                          "Session collaboration receipt differs from its admitted candidate",
                          "outcome-unknown",
                        );
                      }
                      const receipt = candidate;
                      const changes = [...receipt.publication.facts].flatMap<SessionRowChange>(
                        ([sessionKey, fact]) =>
                          fact.kind === "postimage"
                            ? fact.value.map((changeFacts) => ({
                                ...location,
                                sessionKey,
                                scope: "session-entry" as const,
                                facts: changeFacts,
                              }))
                            : [{ ...location, sessionKey, facts: { kind: "unchanged" as const } }],
                      );
                      const result =
                        // SAFETY: Candidate validation binds the result to this command; native receipt equality preserves that pairing.
                        receipt.result as SessionSharingWorkerOperations[Key]["output"];
                      if (!db.isOpen) {
                        publication.settle(undefined, false);
                        publicationState.result = {
                          value: publish(result, location, undefined, new Set()),
                        };
                      } else {
                        publicationState.result = {
                          value: withSqliteCommittedPublications(db, () =>
                            publication.settleChanges(changes, (currentKeys, invalidations) => {
                              const selected = publish(result, location, database, currentKeys);
                              sessionChanges.emitBatch(invalidations, db);
                              return selected;
                            }),
                          ),
                        };
                      }
                    } catch (error) {
                      receiptFailed = true;
                      throw error;
                    }
                  });
                },
              },
            );
            try {
              if (prepare) {
                await worker.run(async (operation) => {
                  const prepared = await prepare(
                    {
                      async execute(prepareCommand, executeOptions) {
                        const result = await operation.execute(prepareCommand, executeOptions);
                        if (
                          prepareCommand.type === "category.prepare" &&
                          Array.isArray(result) &&
                          result.every((key) => typeof key === "string")
                        ) {
                          publicationKeys = result;
                        }
                        return result;
                      },
                    },
                    commandScope,
                  );
                  if (prepared) {
                    capturedCommand.input = structuredClone({ ...prepared, scope: commandScope });
                  }
                  assertQueuedCurrent();
                  mutationDispatched = capturedCommand.type !== "category.prepare";
                  await operation.execute(capturedCommand);
                  resultReceived = true;
                }, assertQueuedCurrent);
              } else {
                assertQueuedCurrent();
                mutationDispatched = capturedCommand.type !== "category.prepare";
                await worker.execute(capturedCommand, assertQueuedCurrent);
                resultReceived = true;
              }
              if (!publicationState.result) {
                throw new SqliteWorkerError(
                  "Session collaboration omitted its native commit receipt",
                  "outcome-unknown",
                );
              }
              return publicationState.result.value;
            } catch (error) {
              await mutationAdmission?.settled;
              if (publicationState.result) {
                return publicationState.result.value;
              }
              const unknown =
                mutationDispatched &&
                (receiptFailed ||
                  resultReceived ||
                  collectNestedErrorCandidates(error).some(
                    (errorCandidate) => extractErrorCode(errorCandidate) === "outcome-unknown",
                  ));
              if (unknown && !capturedCommand.type.startsWith("suggestion.") && db.isOpen) {
                publication.beginChanges(publicationKeys);
              }
              publication.settle(undefined, unknown && db.isOpen);
              throw error;
            } finally {
              publication.settle(undefined, false);
              await worker.close();
            }
          },
          assertQueuedCurrent,
        ),
      true,
    );
  } finally {
    await execution.release();
  }
}

function publishSessionMembership(
  { facts }: MembershipPublication,
  location: { agentId: string; storePath: string; sessionKey: string },
  database: OpenClawAgentDatabase | undefined,
) {
  if (!database) {
    sessionChanges.emit(facts ? { ...location, facts } : { ...location, factsInvalidated: true });
  } else if (facts) {
    publishSessionSharingMemberChange(database, location.sessionKey, facts, location.agentId);
  } else {
    sessionChanges.emit(
      bindSessionEntryPublicationSource({ ...location, factsInvalidated: true }, database),
      database.db,
    );
  }
}

export function addSessionMemberInWorker(
  scope: SessionCollaborationScope,
  params: Parameters<typeof addSessionMember>[1],
  assertCurrent?: () => void,
): Promise<ReturnType<typeof addSessionMember>> {
  const capturedParams = structuredClone({ ...params, addedAt: params.addedAt ?? Date.now() });
  return runSessionCollaborationWrite(
    scope,
    { type: "add", input: { scope, params: capturedParams } },
    (capturedScope) => addSessionMember(capturedScope, capturedParams),
    (result, location, database, currentKeys) => {
      if (result.value.inserted && (!currentKeys || currentKeys.has(location.sessionKey))) {
        publishSessionMembership(result, location, database);
      }
      return result.value;
    },
    assertCurrent,
  );
}

export function removeSessionMemberInWorker(
  scope: SessionCollaborationScope,
  identityId: string,
  expected?: Parameters<typeof removeSessionMember>[2],
  expectedSessionId?: string,
  assertCurrent?: () => void,
  expectedEntry?: Parameters<typeof removeSessionMember>[4],
): Promise<ReturnType<typeof removeSessionMember>> {
  if (!identityId.trim()) {
    return Promise.resolve(null);
  }
  const capturedExpected = expected && structuredClone(expected);
  const capturedExpectedEntry = expectedEntry && structuredClone(expectedEntry);
  return runSessionCollaborationWrite(
    scope,
    {
      type: "remove",
      input: {
        scope,
        identityId,
        expected: capturedExpected,
        expectedSessionId,
        expectedEntry: capturedExpectedEntry,
      },
    },
    (capturedScope) =>
      removeSessionMember(
        capturedScope,
        identityId,
        capturedExpected,
        expectedSessionId,
        capturedExpectedEntry,
      ),
    (result, location, database, currentKeys) => {
      if (result.value && (!currentKeys || currentKeys.has(location.sessionKey))) {
        publishSessionMembership(result, location, database);
      }
      return result.value;
    },
    assertCurrent,
  );
}

export function recordSessionParticipantInWorker(
  scope: SessionCollaborationScope,
  params: Parameters<typeof recordSessionParticipant>[1],
): Promise<ReturnType<typeof recordSessionParticipant>> {
  if (
    !params.identity.id ||
    (params.identity.type === "agent" && params.identity.id === params.sessionAgentId)
  ) {
    return Promise.resolve(null);
  }
  const capturedParams = structuredClone({
    ...params,
    promptedAt: params.promptedAt ?? Date.now(),
  });
  return runSessionCollaborationWrite(
    scope,
    { type: "participant", input: { scope, params: capturedParams } },
    (capturedScope) => recordSessionParticipant(capturedScope, capturedParams),
    (result, location, database, currentKeys) => {
      if (
        (result.value === "inserted" || result.value === "updated") &&
        (!currentKeys || currentKeys.has(location.sessionKey))
      ) {
        if (result.projectionChanged) {
          const change: SessionRowChange = {
            ...location,
            scope: "session-entry",
            facts: { kind: "participants", projection: result.participants },
          };
          sessionChanges.emit(
            database ? bindSessionEntryPublicationSource(change, database) : change,
            database?.db,
          );
        }
        const notify = () =>
          emitSessionLifecycleEvent({
            agentId: location.agentId,
            sessionKey: location.sessionKey,
            reason: "participants",
            scope: "session-entry",
          });
        if (database) {
          deferOpenClawAgentPostCommitPublication(database, notify);
        } else {
          notify();
        }
      }
      return result.value;
    },
  );
}
