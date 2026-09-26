import {
  collectNestedErrorCandidates,
  extractErrorCode,
} from "@openclaw/normalization-core/error-coercion";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import type { SqliteWorkerStore } from "../../infra/sqlite-worker-store.js";
import { emitSessionLifecycleEvent } from "../../sessions/session-lifecycle-events.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
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
import {
  discardCommittedSessionEntryCache,
  publishSessionSharingMemberChange,
} from "./session-accessor.sqlite-entry-cache.js";
import { recordSessionParticipant } from "./session-accessor.sqlite-participants.native.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import { addSessionMember, removeSessionMember } from "./session-sharing-store.native.js";
import type { SessionSharingWorkerOperations } from "./session-sharing-store.worker.js";

export async function runSessionCollaborationWrite<
  Key extends keyof SessionSharingWorkerOperations,
  T,
>(
  scope: SessionAccessScope,
  command: { type: Key; input: SessionSharingWorkerOperations[Key]["input"] },
  native: (scope: SessionAccessScope) => T,
  publish: (
    result: SessionSharingWorkerOperations[Key]["output"],
    location: { agentId: string; storePath: string; sessionKey: string },
    database: OpenClawAgentDatabase,
  ) => T,
  assertCurrent: () => void = () => undefined,
  prepare?: (
    operation: Pick<SqliteWorkerStore<SessionSharingWorkerOperations>, "execute">,
    scope: SessionAccessScope,
  ) => Promise<void>,
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
  const capturedCommand = {
    ...command,
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
                  await prepare(operation, commandScope);
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
                !published &&
                (resultReceived ||
                  collectNestedErrorCandidates(error).some(
                    (candidate) => extractErrorCode(candidate) === "outcome-unknown",
                  ))
              ) {
                // The broker has joined physical settlement. Fence old authority until the
                // projection's existing read worker reconciles the committed store, without replay.
                if (capturedCommand.type === "category.apply") {
                  discardCommittedSessionEntryCache(database.db);
                }
                sessionChanges.emit(
                  capturedCommand.type === "category.apply"
                    ? {
                        all: true,
                        scope: { storePath: location.storePath },
                        factsInvalidated: true,
                      }
                    : { ...location, factsInvalidated: true },
                );
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

export function addSessionMemberInWorker(
  scope: SessionAccessScope,
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
        if (result.facts) {
          publishSessionSharingMemberChange(
            database,
            location.sessionKey,
            result.facts,
            location.agentId,
          );
        } else {
          sessionChanges.emit({ ...location, factsInvalidated: true });
        }
      }
      return result.value;
    },
    assertCurrent,
  );
}

export function removeSessionMemberInWorker(
  scope: SessionAccessScope,
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
        if (result.facts) {
          publishSessionSharingMemberChange(
            database,
            location.sessionKey,
            result.facts,
            location.agentId,
          );
        } else {
          sessionChanges.emit({ ...location, factsInvalidated: true });
        }
      }
      return result.value;
    },
    assertCurrent,
  );
}

export function recordSessionParticipantInWorker(
  scope: SessionAccessScope,
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
    (result, location) => {
      if (result.value === "inserted" || result.value === "updated") {
        if (result.projectionChanged) {
          sessionChanges.emit({
            ...location,
            facts: { kind: "participants", projection: result.participants },
          });
        }
        emitSessionLifecycleEvent({
          agentId: location.agentId,
          sessionKey: location.sessionKey,
          reason: "participants",
        });
      }
      return result.value;
    },
  );
}
