import {
  collectNestedErrorCandidates,
  extractErrorCode,
} from "@openclaw/normalization-core/error-coercion";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import type { SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";
import type { SqliteWorkerStore } from "../../infra/sqlite-worker-store.js";
import { emitSessionLifecycleEvent } from "../../sessions/session-lifecycle-events.js";
import { sessionChanges, type SessionRowChange } from "../../sessions/session-row-changes.js";
import {
  withOpenClawAgentDatabaseAsync,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import {
  isIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.paths.js";
import { captureOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import { openOpenClawAgentSqliteWorkerStore } from "../../state/openclaw-agent-worker-store.js";
import { runOpenClawAgentWriteAdmission } from "../../state/openclaw-agent-write-admission.js";
import { cloneEnvWithPlatformSemantics } from "../config-env-vars.js";
import { resolveStateDir } from "../state-dir.js";
import type { SessionAccessScope } from "./session-accessor.sqlite-contract.js";
import { bindSessionEntryPublicationSource } from "./session-accessor.sqlite-entry-cache-publication.js";
import {
  discardCommittedSessionEntryCache,
  publishSessionSharingMemberChange,
} from "./session-accessor.sqlite-entry-cache.js";
import { recordSessionParticipant } from "./session-accessor.sqlite-participants.native.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import type { SessionCollaborationScope } from "./session-collaboration-scope.js";
import { captureIncognitoSessionOperation } from "./session-incognito-binding.js";
import type { IncognitoSessionAuthority } from "./session-incognito-contract.js";
import type { IncognitoSideDataOperations } from "./session-incognito-side-data-contract.js";
import { addSessionMember, removeSessionMember } from "./session-sharing-store.native.js";
import type {
  MembershipPublication,
  SessionCollaborationMutation,
  SessionSharingWorkerOperations,
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
  ) => T,
  assertCurrent: () => void = () => undefined,
  prepare?: (
    operation: Pick<SqliteWorkerStore<SessionSharingWorkerOperations>, "execute">,
    scope: SessionAccessScope,
  ) => Promise<void | SessionSharingWorkerOperations[Key]["input"]>,
  uncertainCategoryKeys?: () => readonly string[] | undefined,
): Promise<T> {
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
        withOpenClawAgentDatabaseAsync(
          options,
          async (database) => {
            const { db } = database;
            assertQueuedCurrent();
            const worker = await openOpenClawAgentSqliteWorkerStore<SessionSharingWorkerOperations>(
              options,
              db,
              {
                moduleUrl: resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.sessionSharingStore),
                input: undefined,
              },
            );
            let mutationDispatched = false;
            let resultReceived = false;
            let published = false;
            try {
              return await worker.run(async (operation) => {
                if (prepare) {
                  const prepared = await prepare(operation, commandScope);
                  if (prepared) {
                    capturedCommand.input = structuredClone({ ...prepared, scope: commandScope });
                  }
                }
                assertQueuedCurrent();
                mutationDispatched = capturedCommand.type !== "category.prepare";
                const result = await operation.execute(capturedCommand);
                resultReceived = true;
                // Publish while retaining the FIFO section, before later mutations can replace it.
                const value = publish(result, location, database);
                published = true;
                return value;
              }, assertQueuedCurrent);
            } catch (error) {
              if (
                mutationDispatched &&
                !capturedCommand.type.startsWith("suggestion.") &&
                !published &&
                (resultReceived ||
                  collectNestedErrorCandidates(error).some(
                    (candidate) => extractErrorCode(candidate) === "outcome-unknown",
                  ))
              ) {
                // The broker has joined physical settlement. Fence old authority until the
                // projection's existing read worker reconciles the committed store, without replay.
                if (
                  capturedCommand.type === "category.apply" ||
                  capturedCommand.type === "involvement"
                ) {
                  discardCommittedSessionEntryCache(database.db);
                }
                const categoryKeys =
                  capturedCommand.type === "category.apply" ? uncertainCategoryKeys?.() : undefined;
                const changes: SessionRowChange[] = categoryKeys
                  ? categoryKeys.map((sessionKey) => ({
                      storePath: location.storePath,
                      sessionKey,
                      factsInvalidated: "category" as const,
                    }))
                  : [
                      capturedCommand.type === "category.apply"
                        ? {
                            all: true,
                            scope: { storePath: location.storePath },
                            factsInvalidated: true,
                          }
                        : { ...location, factsInvalidated: true },
                    ];
                for (const change of changes) {
                  bindSessionEntryPublicationSource(change, database);
                }
                sessionChanges.emitBatch(changes);
              }
              throw error;
            } finally {
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
    (result, location, database) => {
      if (result.value.inserted) {
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
    (result, location, database) => {
      if (result.value) {
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
    (result, location, database) => {
      if (result.value === "inserted" || result.value === "updated") {
        if (result.projectionChanged) {
          const change: SessionRowChange = {
            ...location,
            scope: "session-entry",
            facts: { kind: "participants", projection: result.participants },
          };
          sessionChanges.emit(
            database ? bindSessionEntryPublicationSource(change, database) : change,
          );
        }
        emitSessionLifecycleEvent({
          agentId: location.agentId,
          sessionKey: location.sessionKey,
          reason: "participants",
          scope: "session-entry",
        });
      }
      return result.value;
    },
  );
}
