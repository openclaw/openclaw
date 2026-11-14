import type { DoctorModelReplacement } from "./doctor/shared/model-replacement.js";

export type DoctorOptions = {
  /** The executable's own Doctor reports a stalled exit; embedded recovery keeps running. */
  watchExitAfterComplete?: boolean;
  modelReplacements?: readonly DoctorModelReplacement[];
  workspaceSuggestions?: boolean;
  yes?: boolean;
  nonInteractive?: boolean;
  deep?: boolean;
  fullIntegrityCheck?: boolean;
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
