import type { ServiceInspectionReason } from "../../daemon/service-inspection-error.js";
import type { GatewayServiceDefinitionBackupReceipt } from "../../daemon/service-stage.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";
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
  servicePort?: number;
  /** Original service generation, which can differ from the invoking CLI package. */
  serviceIdentity?: { version: string; buildId?: string };
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
