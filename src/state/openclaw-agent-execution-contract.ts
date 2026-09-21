import type {
  SqliteWorkerAdmissionFactory,
  SqliteWorkerAdmissionRequest,
} from "../infra/sqlite-worker-operation-admission.js";
import type { AgentDatabaseDomainOperations } from "./openclaw-agent-execution-domain.js";

/** Recorded by the native owner; a descriptor never grants access to that owner. */
export type AgentDatabaseExecutionIdentity = {
  kind: "file";
  physicalIdentity: string;
  incarnation: string;
  nativeLocation: string;
};

export type AgentDatabaseExecutionFileIdentity = Pick<
  AgentDatabaseExecutionIdentity,
  "kind" | "physicalIdentity" | "nativeLocation"
>;

export type AgentDatabaseExecutionOpen = {
  leaseId: string;
  agentId: string;
  databasePath: string;
  stateDatabasePath: string;
  environment: { OPENCLAW_STATE_DIR: string; OPENCLAW_SUPERVISOR_MODE?: "external" };
  expectedIdentity?: AgentDatabaseExecutionFileIdentity;
};

export type AgentDatabaseOperations = AgentDatabaseDomainOperations & {
  "database.prepareWrite": { input: undefined; output: void };
};

/** A request owner composes its retained admission with the native owner's validation. */
export type AgentDatabaseRequestExecutionSource = {
  assertCurrent(): void;
  createAdmission(params: {
    nativeLocations: readonly string[];
    authorize(request: SqliteWorkerAdmissionRequest): void;
    assertCurrent(): void;
  }): SqliteWorkerAdmissionFactory;
};
