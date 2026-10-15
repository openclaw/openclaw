import { WorkerTaskError } from "@openclaw/worker-runtime";
import { GatewayProtocolRequestError } from "../../packages/gateway-client/src/protocol-request.js";
import { AgentDatabaseSchemaAdmissionChangedError } from "../state/agent-database-admission-error.js";
import { AgentDatabaseAdmissionError } from "../state/agent-database-admission.js";
import { StateDatabaseAdmissionPendingError } from "./gateway-state-owner-record.js";
import { isSqliteLockError } from "./sqlite-error-diagnostics.js";
import {
  hasSqliteWorkerOutcomeUnknown,
  isSqliteWorkerError,
  SqliteWorkerAdmissionTimeoutError,
} from "./sqlite-worker-contract.js";

/** Retry availability failures, never infer renewed authority from error text. */
export function isTransientRestartRecoveryError(error: unknown): boolean {
  if (hasSqliteWorkerOutcomeUnknown(error)) {
    return false;
  }
  if (error instanceof GatewayProtocolRequestError) {
    return error.retryable;
  }
  if (error instanceof WorkerTaskError) {
    return error.code === "overloaded" || error.code === "unavailable" || error.code === "timeout";
  }
  if (error instanceof AgentDatabaseAdmissionError) {
    return error.refusal.code === "agent-database-inspection-pending";
  }
  return (
    error instanceof StateDatabaseAdmissionPendingError ||
    error instanceof AgentDatabaseSchemaAdmissionChangedError ||
    error instanceof SqliteWorkerAdmissionTimeoutError ||
    isSqliteWorkerError(error, "overloaded") ||
    isSqliteWorkerError(error, "unavailable") ||
    isSqliteLockError(error)
  );
}
