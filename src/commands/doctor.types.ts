import type { UpdateInitialStoreInvocation } from "../infra/update-initial-store-invocation.js";

/** CLI option shape shared by doctor command entrypoints and prompt helpers. */
export type DoctorOptions = {
  /** Explicit private in-process invocation, not a delegated update authority. */
  initialStores?: UpdateInitialStoreInvocation;
  workspaceSuggestions?: boolean;
  yes?: boolean;
  nonInteractive?: boolean;
  deep?: boolean;
  repair?: boolean;
  force?: boolean;
  generateGatewayToken?: boolean;
  allowExec?: boolean;
  postUpgrade?: boolean;
  stateSqlite?: "compact";
  sessionSqlite?: "dry-run" | "import" | "validate" | "inspect" | "compact" | "restore" | "recover";
  sessionSqliteStore?: string;
  sessionSqliteAgent?: string;
  sessionSqliteAllAgents?: boolean;
  sessionSqliteGithubIssue?: boolean;
  json?: boolean;
};
