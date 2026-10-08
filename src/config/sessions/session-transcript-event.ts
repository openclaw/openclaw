import { isMainThread } from "node:worker_threads";
import { supportsOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import type {
  SessionTranscriptAccessScope,
  TranscriptEvent,
} from "./session-accessor.sqlite-contract.js";
import {
  captureLifecycleDatabaseScope,
  resolveSqliteTranscriptScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { assertNonMessageTranscriptEvent } from "./session-accessor.sqlite-transcript-write-guard.js";
import { appendTranscriptEvent } from "./session-accessor.sqlite-transcript-write.js";
import { runSessionEntryWorkerOperation } from "./session-entry-patch.js";
import { executeSessionMessageRewriteOperation } from "./session-message-rewrite-domain.js";
import type { SessionTranscriptEventCommitted } from "./session-message-rewrite.worker.js";
import { startSessionTranscriptIndexReconcile } from "./session-transcript-reconcile.js";

/** Retain the selected reader through the canonical writer's acknowledged event append. */
export async function appendPreparedTranscriptEvent(
  requested: SessionTranscriptAccessScope,
  event: TranscriptEvent,
  assertCurrent: () => void,
): Promise<void> {
  assertNonMessageTranscriptEvent(event);
  const scope = captureLifecycleDatabaseScope(resolveSqliteTranscriptScope(requested));
  const database = { ...toDatabaseOptions(scope), path: scope.path };
  const eventJson = JSON.stringify(event);
  assertCurrent();
  if (!isMainThread || !supportsOpenClawAgentDatabaseExecution(database)) {
    // Maintenance and process-held incognito retain their existing transaction owner.
    return appendTranscriptEvent(requested, JSON.parse(eventJson), {
      beforeCommitInTransaction: assertCurrent,
    });
  }
  await runSessionEntryWorkerOperation<SessionTranscriptEventCommitted, boolean>({
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
          input: { scope, eventJson },
        }),
      ),
    onCommitted: ({ projectionNeedsReconcile }) => {
      if (projectionNeedsReconcile) {
        startSessionTranscriptIndexReconcile({ ...database, preferredSessionId: scope.sessionId });
      }
      return true;
    },
  });
}
