import { isMainThread } from "node:worker_threads";
import { IncognitoSessionMissingError } from "../../state/incognito-session-error.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type {
  SessionTranscriptAccessScope,
  SessionTranscriptWriteScope,
  TranscriptEvent,
} from "./session-accessor.sqlite-contract.js";
import {
  captureLifecycleDatabaseScope,
  resolveSqliteTranscriptScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import {
  assertLockedTranscriptWriteAllowed,
  assertNonMessageTranscriptEvent,
} from "./session-accessor.sqlite-transcript-write-guard.js";
import { appendTranscriptEvent } from "./session-accessor.sqlite-transcript-write.js";
import {
  captureSessionActorStorageOwner,
  getSessionActorStorageBinding,
  withSessionActorStorage,
  type SelectedSessionActorStorageBinding,
} from "./session-actor-storage-binding.js";
import { readSessionActorStorageResult } from "./session-actor-storage-result.js";
import { runSessionEntryWorkerOperation } from "./session-entry-patch.js";
import { executeSessionMessageRewriteOperation } from "./session-message-rewrite-domain.js";
import type { SessionTranscriptEventCommitted } from "./session-transcript-mutation.types.js";
import { startSessionTranscriptIndexReconcile } from "./session-transcript-reconcile.js";
import {
  captureOwnedTranscriptWriteAssertion,
  withOwnedSessionTranscriptWriterFence,
} from "./transcript-write-context.js";

/** Retain the selected reader through the canonical writer's acknowledged event append. */
export async function appendPreparedTranscriptEvent(
  requested: SessionTranscriptAccessScope & SessionTranscriptWriteScope,
  event: TranscriptEvent,
  assertCurrent: () => void,
): Promise<boolean> {
  assertNonMessageTranscriptEvent(event);
  const fenced = withOwnedSessionTranscriptWriterFence(requested);
  const eventJson = JSON.stringify(event);
  const assertOwned = captureOwnedTranscriptWriteAssertion(fenced);
  const assertWriteCurrent = () => {
    assertOwned();
    assertCurrent();
  };
  const authority = { assertCurrent: assertWriteCurrent, authorize: assertWriteCurrent };
  const memory = captureSessionActorStorageOwner(fenced, authority);
  if (memory) {
    const append = async (binding: SelectedSessionActorStorageBinding) =>
      readSessionActorStorageResult(
        await binding.actor.storage.mutate(
          {
            type: "session.event.append",
            input: {
              scope: {
                ...fenced,
                agentId: binding.agentId,
                sessionKey: binding.actor.target.sessionKey,
                storePath: binding.path,
              },
              eventJson,
            },
          },
          memory.authority,
        ),
      );
    const binding = getSessionActorStorageBinding(fenced);
    if (binding) {
      return append(binding);
    }
    const appended = await withSessionActorStorage(
      fenced,
      {
        authority,
        lifetime: { assertCurrent: assertWriteCurrent, assertReadable: assertWriteCurrent },
      },
      append,
    );
    if (appended === undefined) {
      throw new IncognitoSessionMissingError();
    }
    return appended;
  }
  const scope = captureLifecycleDatabaseScope(resolveSqliteTranscriptScope(fenced));
  const database = { ...toDatabaseOptions(scope), path: scope.path };
  assertCurrent();
  if (!isMainThread) {
    // Maintenance retains its existing transaction owner.
    return appendTranscriptEvent(fenced, JSON.parse(eventJson), {
      beforeCommitInTransaction() {
        assertCurrent();
        assertLockedTranscriptWriteAllowed(openOpenClawAgentDatabase(database), scope, fenced);
      },
    });
  }
  return runSessionEntryWorkerOperation<SessionTranscriptEventCommitted, boolean>({
    database,
    agentId: scope.agentId,
    assertCurrent,
    candidateKind: "session-transcript-event",
    prepareWorker: () => ({
      async prepare() {
        const { restoreSessionColdTranscript } = await import("./session-cold-storage.js");
        await restoreSessionColdTranscript({ ...requested, env: scope.env }, assertCurrent);
      },
      beforeWrite: assertCurrent,
      async release() {},
    }),
    run: (worker, commit) =>
      commit(() =>
        executeSessionMessageRewriteOperation(worker, database.agentId, {
          type: "session.transcript.event.append",
          input: { scope, eventJson, fence: fenced },
        }),
      ),
    onCommitted: ({ appended, projectionNeedsReconcile }) => {
      if (projectionNeedsReconcile) {
        startSessionTranscriptIndexReconcile({ ...database, preferredSessionId: scope.sessionId });
      }
      return appended;
    },
  });
}
