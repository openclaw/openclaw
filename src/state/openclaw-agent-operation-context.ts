import type { DatabasePathIdentity } from "../infra/sqlite-worker-identity.js";
import type {
  OpenClawAgentDatabase,
  OpenClawAgentDatabaseOptions,
} from "./openclaw-agent-db-contract.js";
import type { OpenClawStateDatabase } from "./openclaw-state-db-contract.js";

export type AgentWorkerOperationContext = {
  open: () => OpenClawAgentDatabase;
  options: OpenClawAgentDatabaseOptions & { path: string };
  admit: (stage: "transaction" | "commit", publication?: unknown) => void;
  writeTransaction: <T>(
    operationLabel: string,
    owner: string,
    write: (current: OpenClawAgentDatabase) => T,
  ) => T;
  /** Durable executors lend their exact admitted shared owner to native binding settlement. */
  writeSharedTransaction?: <T>(
    source: DatabasePathIdentity,
    write: (current: OpenClawStateDatabase) => T,
  ) => T;
};
