import type { Transferable } from "node:worker_threads";
import type { SqliteTransactionOptions } from "../infra/sqlite-transaction.js";
import type { DatabasePathIdentity } from "../infra/sqlite-worker-identity.js";
import type {
  OpenClawAgentDatabase,
  OpenClawAgentDatabaseOptions,
} from "./openclaw-agent-db-contract.js";
import type { OpenClawStateDatabase } from "./openclaw-state-db-contract.js";

export type AgentWorkerOperationContext = {
  open: () => OpenClawAgentDatabase;
  options: OpenClawAgentDatabaseOptions & { path: string };
  admit: (
    stage: "prepare" | "transaction" | "commit",
    publication?: unknown,
    transferList?: Transferable[],
  ) => void;
  writeTransaction: <T>(
    operationLabel: string,
    owner: string,
    write: (current: OpenClawAgentDatabase) => T,
    diagnosticContext?: SqliteTransactionOptions["diagnosticContext"],
    /** The owner prepared its receipt and final admission before one terminal statement. */
    singleStatement?: boolean,
  ) => T;
  /** Durable executors lend their exact admitted shared owner to native binding settlement. */
  writeSharedTransaction?: <T>(
    source: DatabasePathIdentity,
    write: (current: OpenClawStateDatabase) => T,
  ) => T;
};
