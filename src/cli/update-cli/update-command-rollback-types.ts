import type { ConfigFileSnapshot } from "../../config/types.openclaw.js";
import type { PackageUpdateTransaction } from "../../infra/package-update-steps.js";
import type { UpdateStateSchemaVersion } from "../../infra/update-candidate-state.js";
import type { UpdateRunResult } from "../../infra/update-run-result.js";
import type { OpenClawSchemaVersions } from "../../state/openclaw-schema-versions.js";
import type { UpdateCommandOptions } from "./shared.js";
import type { UpdateConfigSnapshot } from "./update-command-config-snapshot.js";
import type {
  OriginalManagedServiceRuntime,
  UpdateServiceDefinitionRecovery,
} from "./update-command-service-context-types.js";
import type { PreManagedServiceStop } from "./update-command-service.js";

export type RollbackFailedUpdateParams = {
  result: UpdateRunResult;
  previousRoot: string;
  packageTransaction?: PackageUpdateTransaction;
  rollbackBlockedReason?: "state-migrated-no-rollback" | "rollback-state-unverified";
  schemaVersions?: UpdateStateSchemaVersion[];
  candidateSchemaVersions?: OpenClawSchemaVersions;
  previousSchemaVersions?: OpenClawSchemaVersions;
  previousVerified?: boolean;
  originalManagedServiceRuntime?: OriginalManagedServiceRuntime;
  allowGatewayRestart?: boolean;
  configSnapshot: ConfigFileSnapshot;
  activationConfig?: UpdateConfigSnapshot;
  opts: UpdateCommandOptions;
  preManagedServiceStop?: PreManagedServiceStop;
  timeoutMs: number;
  nodeRunner?: string;
  invocationCwd?: string;
  definitionRecovery: UpdateServiceDefinitionRecovery;
};

export type RollbackFailedUpdateResult = {
  result: UpdateRunResult;
  rolledBack: boolean;
  stoppedForRollback?: PreManagedServiceStop;
  verifiedAtMs?: number;
  pendingRecoveryReason?: string;
  originalServiceRecovery?: "healthy" | "failed";
};
