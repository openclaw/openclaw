import type { DaemonRuntimePinSnapshot } from "../../daemon/runtime-pin-types.js";
import type { ServiceInspectionReason } from "../../daemon/service-inspection-error.js";
import type { GatewayServiceDefinitionBackupReceipt } from "../../daemon/service-stage.js";
import type { GatewayServiceCommandConfig } from "../../daemon/service-types.js";
import type {
  PackageDirectoryIdentity,
  PackageIntegrityFingerprint,
  PackageLauncherFingerprint,
} from "../../infra/package-update-integrity.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import type { OpenClawSchemaVersions } from "../../state/openclaw-schema-versions.js";
import type { WindowsTaskAutoStartRecovery } from "./update-command-windows-task.js";

/** One native rewrite per finalization; subsequent activation preserves its publication. */
export type UpdateServiceDefinitionRecovery = {
  backup?: GatewayServiceDefinitionBackupReceipt;
  preserved?: boolean;
  unverified?: boolean;
};

export type ManagedGatewayUpdateVerdict =
  | { kind: "absent" | "foreign" }
  | {
      kind: "owned";
      root: string;
      fingerprint: string;
      refreshDefinition: boolean;
      requiresInstallRootRefresh?: boolean;
    }
  | { kind: "unresolved"; root: string; fingerprint: string }
  | { kind: "unavailable"; message: string; inspectionReason?: ServiceInspectionReason };

export type PreManagedServiceStop = {
  stoppedAtMs?: number;
  stopped: boolean;
  inspected: boolean;
  runtimeInspected: boolean;
  running: boolean;
  /** Verified native service process, used only to correlate legacy Gateway locks. */
  servicePid?: number;
  offline?: boolean;
  serviceMutationAllowed?: boolean;
  serviceMutationSkipMessage?: string;
  serviceUpdateVerdict?: ManagedGatewayUpdateVerdict;
  blockMessage?: string;
  serviceEnv?: NodeJS.ProcessEnv;
  serviceDefinitionEnv?: NodeJS.ProcessEnv;
  serviceNodeRunner?: string;
  /** Original account observed from the pinned native user-manager connection. */
  serviceManagerUid?: number;
  windowsTaskAutoStartRecovery?: WindowsTaskAutoStartRecovery;
};

export type UpdateRestartParams = {
  result: UpdateRunResult;
  root: string;
  preManagedServiceStop?: PreManagedServiceStop;
  ownedManagedUpdateEnv?: NodeJS.ProcessEnv;
  invocationCwd?: string;
  shouldRestart: boolean;
  updateStepTimeoutMs: number;
  serviceRuntimeRefreshRequired?: boolean;
};

/** Observation of service A, never evidence of package B restoration or authority. */
export type OriginalManagedServiceRuntime = {
  root: string;
  nodeRunner: string;
  version: string | null;
  buildId?: string;
  schemaVersions?: OpenClawSchemaVersions;
  verified: boolean;
  definition: {
    command: GatewayServiceCommandConfig;
    fingerprint: string;
    rebound?: string;
    reboundRuntimePin?: string;
    runtimePin: DaemonRuntimePinSnapshot;
  };
  service: Pick<PreManagedServiceStop, "serviceEnv" | "serviceUpdateVerdict" | "serviceManagerUid">;
  packageIdentity: PackageDirectoryIdentity;
  packageFingerprint?: PackageIntegrityFingerprint;
  packageFingerprintWarning?: string;
  launcher: {
    path: string;
    realPath: string;
    fingerprint: PackageLauncherFingerprint;
    targetFingerprint: PackageLauncherFingerprint;
  };
  nodeIdentity: string;
};
