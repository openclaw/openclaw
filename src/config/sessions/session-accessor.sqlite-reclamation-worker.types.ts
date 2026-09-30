import type { SqliteWalCheckpointSnapshot } from "../../infra/sqlite-wal-checkpoint.js";
import type { DatabasePathIdentity } from "../../infra/sqlite-worker-identity.js";
import type {
  OpenClawAgentDatabaseClaim,
  readOpenClawAgentDatabaseIdentity,
} from "../../state/openclaw-agent-db-identity.js";
import type { OpenClawAgentDatabaseWorkerLeaseReceipt } from "../../state/openclaw-agent-db-lease.js";
import type { OpenClawAgentDatabaseValidation } from "../../state/openclaw-agent-db-validation-cache.js";
import type {
  SqliteSessionReclamationPlan,
  SqliteSessionReclamationResult,
} from "./session-accessor.sqlite-lifecycle-types.js";
import type { SqliteMutationWorkerCoordination } from "./session-accessor.sqlite-worker-coordination.js";
import type { SqliteMutationWorkerMessage } from "./session-accessor.sqlite-worker-request.js";

export type SqliteReclamationClaim = Pick<OpenClawAgentDatabaseClaim, "identity" | "assertCurrent">;

/** A captured existing-file expectation is not an admitted native claim. */
export type SqliteReclamationExistingSource = Pick<
  DatabasePathIdentity,
  "key" | "canonicalPath"
> & {
  birthtime?: string;
};
export type SqliteReclamationPreparedSource = Omit<
  ReturnType<typeof readOpenClawAgentDatabaseIdentity>,
  "identity"
> & { identity: string };
export type SqliteReclamationPreparation = {
  source: SqliteReclamationPreparedSource;
  validation: OpenClawAgentDatabaseValidation | undefined;
};
export type SqliteReclamationPrepareRequest = {
  type: "prepare";
  operationId: number;
  databaseOptions: SqliteSessionReclamationPlan["databaseOptions"];
  expectedSource: SqliteReclamationExistingSource;
  coordination: SqliteMutationWorkerCoordination;
};

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
  | SqliteMutationWorkerMessage<SqliteSessionReclamationResult | SqliteReclamationPreparation>
  | { type: "lease"; receipt: OpenClawAgentDatabaseWorkerLeaseReceipt }
  | { type: "checkpoint"; operationId: number; snapshot: SqliteWalCheckpointSnapshot }
  | ({ type: "closed" } & WorkerCleanup);
