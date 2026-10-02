import type {
  OpenClawAgentDatabase,
  OpenClawAgentDatabaseOptions,
} from "./openclaw-agent-db-contract.js";

export type AgentWorkerOperationContext = {
  open: () => OpenClawAgentDatabase;
  options: OpenClawAgentDatabaseOptions & { path: string };
  admit: (stage: "transaction" | "commit", publication?: unknown) => void;
  writeTransaction: <T>(
    operationLabel: string,
    owner: string,
    write: (current: OpenClawAgentDatabase) => T,
  ) => T;
};
