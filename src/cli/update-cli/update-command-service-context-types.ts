import type { DaemonRuntimePinSnapshot } from "../../daemon/runtime-pin-types.js";
import type { ServiceInspectionReason } from "../../daemon/service-inspection-error.js";
import type { GatewayServiceDefinitionBackupReceipt } from "../../daemon/service-stage.js";
import type {
  GatewayServiceCommandConfig,
  GatewayServiceState,
  SystemdServiceIdentity,
} from "../../daemon/service-types.js";
import type {
  PackageDirectoryIdentity,
  PackageLauncherFingerprint,
} from "../../infra/package-update-integrity.js";
import type { UpdateFailureFact } from "../../infra/update-failure-facts.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import type { OpenClawSchemaVersions } from "../../state/openclaw-schema-versions.js";
import type { UpdateCommandOptions } from "./shared.js";
import type { PluginUpdateWarning } from "./update-command-plugins-internals.js";
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

export type ManagedGatewayServiceObservation = {
  serviceUpdateVerdict?: ManagedGatewayUpdateVerdict;
  serviceEnv?: NodeJS.ProcessEnv;
  /** Original account observed from the pinned native user-manager connection. */
  serviceManagerUid?: number;
};

export type ManagedGatewayRuntimeObservation = ManagedGatewayServiceObservation & {
  running: boolean;
  serviceDefinitionEnv?: NodeJS.ProcessEnv;
  serviceNodeRunner?: string;
};

export type PreManagedServiceStop = ManagedGatewayRuntimeObservation & {
  stoppedAtMs?: number;
  stopped: boolean;
  inspected: boolean;
  runtimeInspected: boolean;
  /** Verified native service process, used only to correlate legacy Gateway locks. */
  servicePid?: number;
  /** Native enable policy captured before our stop; absence is unknown. */
  serviceAutoStartEnabled?: boolean;
  serviceControlGroup?: string;
  /** Reporting fact only; membership is rechecked before the native stop. */
  serviceMembershipSourceAbsent?: boolean;
  offline?: boolean;
  serviceMutationAllowed?: boolean;
  serviceMutationSkipMessage?: string;
  blockMessage?: string;
  blockFailureFacts?: UpdateFailureFact[];
  servicePort?: number;
  /** Original service generation, which can differ from the invoking CLI package. */
  serviceIdentity?: { version: string; buildId?: string };
  serviceSystemdIdentity?: SystemdServiceIdentity;
  windowsTaskAutoStartRecovery?: WindowsTaskAutoStartRecovery;
};

export type UpdateRestartParams = {
  originalManagedServiceRuntime?: OriginalManagedServiceRuntime;
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
    runtimePin: DaemonRuntimePinSnapshot | undefined;
  };
  service: ManagedGatewayServiceObservation;
  packageIdentity: PackageDirectoryIdentity;
  launcher: {
    path: string;
    realPath: string;
    fingerprint: PackageLauncherFingerprint;
    targetFingerprint: PackageLauncherFingerprint;
  };
  nodeIdentity: string;
};

export type ManagedServiceRootRedirect = {
  root: string;
  previousRoot: string;
};

export type ManagedServicePackageUpdatePlan = {
  rootRedirect: ManagedServiceRootRedirect | null;
  serviceRoot?: string;
  nodeRunner?: string;
  serviceUnitTarget?: string;
  service?: ManagedGatewayRuntimeObservation;
};

export type ManagedServiceStopParams = {
  recovery?: unknown;
  updateRun?: UpdateCommandOptions["run"];
  recordPhase?: (phase: "activating") => Promise<void>;
  updateInstallKind: "git" | "package";
  root: string;
  shouldRestart: boolean;
  jsonMode: boolean;
  phase?: "inspect" | "prepare" | "refresh";
  /** Package/helper root can differ from the inspected service during a rebind. */
  handoffRoot?: string;
  handoffFromGateway?: (state: GatewayServiceState) => Promise<boolean>;
  expectedService?: ManagedGatewayServiceObservation &
    Partial<Pick<PreManagedServiceStop, "stopped">>;
  allowInstallRootChange?: boolean;
  onStopped?: (state: PreManagedServiceStop) => void;
  /** Inspection-only selection; never copied into recovery or finalizer records. */
  onOwnedStartupRuntime?: (executable: string | undefined) => void;
  /** Doctor restores this same native instance after its offline repair. */
  retainNativeIdentity?: boolean;
  assertCurrent?: (phase?: "restore") => void;
  /** Revalidate a parent deadline immediately before the native stop side effect. */
  assertDeadline?: () => void;
  waitForCurrent?: () => Promise<void>;
  timeoutMs?: number;
  warn?: (message: string) => void;
} & (
  | { recordPhase: (phase: "activating") => Promise<void> }
  | { updateRun?: undefined }
  | { phase: "inspect" | "refresh" }
);

export type UpdateServiceRestartParams = {
  originalManagedServiceRuntime?: OriginalManagedServiceRuntime;
  shouldRestart: boolean;
  observePackageReplacement?: boolean;
  result: UpdateRunResult;
  opts: UpdateCommandOptions;
  refreshServiceEnv: boolean;
  serviceRuntimeRefreshRequired?: boolean;
  serviceEnv?: NodeJS.ProcessEnv;
  serviceInstallEnv?: NodeJS.ProcessEnv | null;
  serviceUpdateVerdict?: ManagedGatewayUpdateVerdict;
  serviceManagerUid?: number;
  gatewayPort: number;
  invocationCwd?: string;
  nodeRunner?: string;
  skipLegacyServiceRestart?: boolean;
  requireRunningServiceAfterRestart?: boolean;
  serviceMutationSkipMessage?: string;
  timeoutMs: number;
  onVerificationFailure?: (reason: string) => void;
  onPluginWarnings?: (warnings: readonly PluginUpdateWarning[]) => void;
  onVerified?: (verifiedAtMs: number) => void;
  onGatewayStartAttempted?: () => void;
  definitionRecovery?: UpdateServiceDefinitionRecovery;
  expectedGatewayIdentity?: { version: string; buildId?: string };
};
