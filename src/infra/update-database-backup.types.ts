import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { UpdateDatabaseBackup } from "./update-database-backup.js";

export type UpdateDatabaseBackupInput = {
  backupRoot: string;
  stateDir: string;
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  additionalPaths?: readonly string[];
  additionalFiles?: readonly string[];
  preserveSourceArtifacts?: boolean;
  integrityCheck?: "quick" | "full";
  /** Native migration owns the stopped Gateway until Doctor takes custody. */
  stopped?: boolean;
  postgresOffline?: boolean;
  /** Migration exporters may require a physical engine before any server export. */
  sourceEngine?: "sqlite";
  /** Manual recovery evidence: live commits after its coherent image change nothing it promises. */
  originalState?: boolean;
  pluginOwners?: UpdateDatabaseBackup["pluginOwners"];
};
