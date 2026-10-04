import { emitSessionLifecycleEvent } from "../../sessions/session-lifecycle-events.js";
import type { OpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution-contract.js";
import { publishCommittedSessionIdentity } from "./session-accessor.sqlite-identity.js";
import type { ReclamationDatabaseOptions } from "./session-accessor.sqlite-lifecycle-types.js";
import { runSessionEntryWorkerOperation } from "./session-entry-patch.js";
import type {
  SessionLifecycleProjectionCommit,
  SessionLifecycleProjectionCommitted,
} from "./session-lifecycle-projection.types.js";
import { startSessionTranscriptIndexReconcile } from "./session-transcript-reconcile.js";

export function commitSessionLifecycleProjectionInWorker(params: {
  database: ReclamationDatabaseOptions;
  input: SessionLifecycleProjectionCommit;
  execution: OpenClawAgentDatabaseExecution;
  assertCurrent: () => void;
  assertPreservationCurrent: () => void;
  onLifecycleCommitted?: () => void;
}) {
  return runSessionEntryWorkerOperation<
    SessionLifecycleProjectionCommitted,
    SessionLifecycleProjectionCommitted["result"]
  >({
    database: params.database,
    agentId: params.input.agentId,
    assertCurrent: params.assertCurrent,
    assertPrepared: params.assertPreservationCurrent,
    assertCandidate: params.assertPreservationCurrent,
    retainedExecution: params.execution,
    candidateKind: "session-lifecycle-projection",
    run: (worker, commit) =>
      commit(() => worker.execute({ type: "session.lifecycle.project", input: params.input })),
    onAcknowledged(candidate) {
      params.onLifecycleCommitted?.();
      for (const sessionId of candidate.projectionReconcileSessionIds) {
        startSessionTranscriptIndexReconcile({ ...params.database, preferredSessionId: sessionId });
      }
    },
    onCommitted(candidate, published, identity) {
      for (const sessionKey of candidate.progressCardResetKeys) {
        emitSessionLifecycleEvent({
          agentId: params.input.agentId,
          sessionKey,
          reason: "progress-card-reset",
        });
      }
      if (published) {
        publishCommittedSessionIdentity(
          params.input.agentId,
          identity,
          published.previous,
          published.current,
          published.prepared,
        );
      }
      return candidate.result;
    },
  });
}
