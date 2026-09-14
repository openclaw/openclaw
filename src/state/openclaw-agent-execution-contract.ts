import type {
  HeartbeatOutcomeInput,
  HeartbeatOutcomeRow,
} from "../infra/heartbeat-outcome-store.kernel.js";
import type { RetainedWorkerTransactionAdmission } from "../infra/sqlite-worker-operation-settlement.js";

/** Recorded by the native owner; a descriptor never grants access to that owner. */
export type AgentDatabaseExecutionIdentity = {
  kind: "file";
  physicalIdentity: string;
  incarnation: string;
  nativeLocation: string;
};

export type AgentDatabaseExecutionOpen = {
  leaseId: string;
  agentId: string;
  databasePath: string;
  stateDatabasePath: string;
  environment: { OPENCLAW_STATE_DIR: string; OPENCLAW_SUPERVISOR_MODE?: "external" };
};

export type AgentDatabaseOperations = {
  "database.identity": { input: undefined; output: AgentDatabaseExecutionIdentity };
  "heartbeat.persist": { input: HeartbeatOutcomeInput; output: void };
  "heartbeat.claim": {
    input: { sessionKey: string; runId: string };
    output: HeartbeatOutcomeRow | undefined;
  };
};

export type AgentDatabaseExecutionSource = {
  assertCurrent(): void;
  admitTransaction(operation: RetainedWorkerTransactionAdmission, grant: () => boolean): void;
};
