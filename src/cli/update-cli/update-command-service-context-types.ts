import type { PackageIntegrityFingerprint } from "../../infra/package-update-integrity.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import type { OpenClawSchemaVersions } from "../../state/openclaw-schema-versions.js";
import type { ManagedGatewayUpdateVerdict } from "./update-command-service-plan.js";
import type { WindowsTaskAutoStartRecovery } from "./update-command-windows-task.js";

export type PreManagedServiceStop = {
  stoppedAtMs?: number;
  stopped: boolean;
  inspected: boolean;
  runtimeInspected: boolean;
  running: boolean;
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
  service: Pick<PreManagedServiceStop, "serviceEnv" | "serviceUpdateVerdict" | "serviceManagerUid">;
  packageFingerprint: PackageIntegrityFingerprint;
  nodeIdentity: string;
};
