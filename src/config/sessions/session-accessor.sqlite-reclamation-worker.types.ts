import type { SqliteWalCheckpointSnapshot } from "../../infra/sqlite-wal-checkpoint.js";
import type { OpenClawAgentDatabaseWorkerLeaseReceipt } from "../../state/openclaw-agent-db-lease.js";
import type {
  SqliteSessionReclamationPlan,
  SqliteSessionReclamationResult,
} from "./session-accessor.sqlite-lifecycle-types.js";
import type { SqliteMutationWorkerCoordination } from "./session-accessor.sqlite-worker-coordination.js";
import type { SqliteMutationWorkerMessage } from "./session-accessor.sqlite-worker-request.js";

export type SqliteReclamationWorkerRequest = {
  type: "reclaim";
  operationId: number;
  commitGate: SharedArrayBuffer;
  plan: SqliteSessionReclamationPlan;
  coordination: SqliteMutationWorkerCoordination;
};
export type SqliteReclamationWorkerCloseRequest = {
  type: "close";
  operationId: number;
  coordination: SqliteMutationWorkerCoordination;
};
export type SqliteCanonicalValidationWorkerRequest = {
  type: "canonical-validation";
  operationId: number;
  commitGate: SharedArrayBuffer;
  databaseOptions: SqliteSessionReclamationPlan["databaseOptions"];
  maxRows: number;
  maxBytes: number;
  initializeCanonicalValidation: boolean;
  coordination: SqliteMutationWorkerCoordination;
};
export type WorkerCleanup = { cleanupWarnings: string[]; settled: boolean };
export type SqliteReclamationWorkerMessage =
  | SqliteMutationWorkerMessage<SqliteSessionReclamationResult>
  | { type: "lease"; receipt: OpenClawAgentDatabaseWorkerLeaseReceipt }
  | { type: "checkpoint"; operationId: number; snapshot: SqliteWalCheckpointSnapshot }
  | ({ type: "closed" } & WorkerCleanup);
