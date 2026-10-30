import { isAbortError } from "../../infra/abort-signal.js";
import { StateDatabaseAdmissionPendingError } from "../../infra/gateway-state-owner-record.js";
import { isSqliteLockError } from "../../infra/sqlite-error-diagnostics.js";
import { isSqliteWorkerError } from "../../infra/sqlite-worker-contract.js";
import {
  AgentDatabaseExecutionAdmissionClosedError,
  AgentDatabaseSchemaAdmissionChangedError,
} from "../../state/agent-database-admission-error.js";
import {
  AgentDatabaseAdmissionError,
  createAgentDatabaseAdmissionErrorShape,
} from "../../state/agent-database-admission.js";
import { isStateDatabaseReadAdmissionInvalidatedError } from "../../state/openclaw-state-db-async-lifecycle.js";

/** Replay retains the batch identity and rechecks current run and database authority. */
export function isReplayableWorkerTranscriptCommitError(error: unknown): boolean {
  if (error instanceof AgentDatabaseAdmissionError) {
    return createAgentDatabaseAdmissionErrorShape(error.refusal).retryable === true;
  }
  // Cleanup aggregates do not certify that the failed operation can be retried.
  return (
    isSqliteLockError(error) ||
    error instanceof AgentDatabaseExecutionAdmissionClosedError ||
    error instanceof AgentDatabaseSchemaAdmissionChangedError ||
    error instanceof StateDatabaseAdmissionPendingError ||
    isStateDatabaseReadAdmissionInvalidatedError(error) ||
    isAbortError(error) ||
    isSqliteWorkerError(error, "closed") ||
    isSqliteWorkerError(error, "overloaded") ||
    isSqliteWorkerError(error, "unavailable") ||
    isSqliteWorkerError(error, "outcome-unknown")
  );
}
