import { isMainThread } from "node:worker_threads";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { supportsOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
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
import { runSessionEntryWorkerOperation } from "./session-entry-patch.js";
import { captureIncognitoSessionOperation } from "./session-incognito-binding.js";
import { executeSessionMessageRewriteOperation } from "./session-message-rewrite-domain.js";
import type { SessionTranscriptEventCommitted } from "./session-transcript-mutation.types.js";
import { startSessionTranscriptIndexReconcile } from "./session-transcript-reconcile.js";
import { withOwnedSessionTranscriptWriterFence } from "./transcript-write-context.js";

/** Retain the selected reader through the canonical writer's acknowledged event append. */
export async function appendPreparedTranscriptEvent(
  requested: SessionTranscriptAccessScope & SessionTranscriptWriteScope,
  event: TranscriptEvent,
  assertCurrent: () => void,
): Promise<boolean> {
  assertNonMessageTranscriptEvent(event);
  const fenced = withOwnedSessionTranscriptWriterFence(requested);
  const scope = captureLifecycleDatabaseScope(resolveSqliteTranscriptScope(fenced));
  const database = { ...toDatabaseOptions(scope), path: scope.path };
  const eventJson = JSON.stringify(event);
  assertCurrent();
  const incognito = captureIncognitoSessionOperation(fenced);
  if (incognito) {
    const committed = await incognito.actor.sessions.transcript(
      {
        assertCurrent() {
          incognito.authority.assertCurrent();
          assertCurrent();
        },
      },
      {
        type: "session.event.append",
        input: {
          sessionKey: scope.sessionKey,
          sessionId: scope.sessionId,
          fence: {
            expectedLifecycleRevision: fenced.expectedLifecycleRevision,
            expectedWriterRunId: fenced.expectedWriterRunId,
            expectedOwner: fenced.expectedOwner,
          },
          eventJson,
        },
      },
      undefined,
      undefined,
      ({ projectionNeedsReconcile }) => {
        if (projectionNeedsReconcile) {
          startSessionTranscriptIndexReconcile({
            ...database,
            preferredSessionId: scope.sessionId,
          });
        }
      },
    );
    return committed.appended;
  }
  if (!isMainThread || !supportsOpenClawAgentDatabaseExecution(database)) {
    // Maintenance and process-held incognito retain their existing transaction owner.
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
