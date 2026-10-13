import type { LegacyConfigUpdatePlan } from "../../commands/doctor/legacy-config-repair.js";
import type { PackageActivationRuntime } from "../../infra/package-update-activation-runtime.types.js";
import type { DevUpdateTarget } from "../../infra/update-dev-target.js";
import type { ResolvedGlobalInstallTarget } from "../../infra/update-global.js";
import type { UpdateRunPhasePatch } from "../../infra/update-run-mutation.types.js";
import type {
  UpdateRunPhase,
  UpdateRunRecord,
  UpdateRunStep,
} from "../../infra/update-run-record.js";
import type { UpdateRecoveryFence } from "../../infra/update-run-recovery.js";
import type { UpdateRunWriteOptions } from "../../infra/update-run-write.async.js";
import type { UpdateStepProgress } from "../../infra/update-runner-types.js";
import type { OpenClawSchemaVersions } from "../../state/openclaw-schema-versions.js";
import type { UpdateCommandOptions } from "./shared.js";
import type { StagedPackageInstallUpdate } from "./update-command-package.js";
import type { ManagedServiceRootRedirect } from "./update-command-service-context-types.js";
import type { UpdateCommandRecoveryState } from "./update-command-service.js";

type CapturedWriteOptions = Required<
  Pick<UpdateRunWriteOptions, "env" | "context" | "assertAccepting" | "retainSettlement">
> &
  Pick<UpdateRunWriteOptions, "requireNoRecovery" | "busyTimeoutMs">;

export type UpdateCommandExecutionGuards = {
  recordPhase: (phase: UpdateRunPhase, patch?: UpdateRunPhasePatch) => Promise<void>;
  recordStep: (step: UpdateRunStep) => Promise<UpdateRunRecord | undefined>;
  captureWriteOptions: () => CapturedWriteOptions;
  onStateHandoff: () => void;
  admitExecutor: (acquired: UpdateRecoveryFence) => void;
  assertCurrent: (phase?: "restore") => void;
  assertBoundChildCurrent: () => void;
};

export type MutableUpdateExecutionParams = {
  root: string;
  installKind: "git" | "package" | "unknown";
  updateInstallKind: "git" | "package";
  switchToGit: boolean;
  timeoutMs: number | undefined;
  updateStepTimeoutMs: number;
  startedAt: number;
  progress: UpdateStepProgress;
  executionGuards: UpdateCommandExecutionGuards;
  stop: () => void;
  channel: "stable" | "extended-stable" | "beta" | "dev";
  tag: string;
  opts: UpdateCommandOptions;
  shouldRestart: boolean;
  devTarget?: DevUpdateTarget;
  packageInstallSpec: string | null;
  packageInstallEnv?: NodeJS.ProcessEnv;
  packageInstallTarget?: ResolvedGlobalInstallTarget;
  stagedPackage?: StagedPackageInstallUpdate;
  packageTargetVersion?: string;
  packageTargetSchemaVersions?: OpenClawSchemaVersions;
  packageUpdateNodeRunner?: string;
  packageActivationRuntime?: PackageActivationRuntime;
  managedServiceNodeRunner?: string;
  managedServiceRootRedirect: ManagedServiceRootRedirect | null;
  managedServiceRoot?: string;
  invocationCwd?: string;
  legacyConfigPlan?: LegacyConfigUpdatePlan;
  callerLegacyConfigPlan?: LegacyConfigUpdatePlan;
  recoveryState: UpdateCommandRecoveryState;
  prepareMutableUpdate: (
    env: NodeJS.ProcessEnv | undefined,
    activationTimeoutMs: number | undefined,
    admitExecutor: (fence: UpdateRecoveryFence) => void,
    installTarget?: ResolvedGlobalInstallTarget,
  ) => Promise<void>;
  onActivation?: () => void;
};
