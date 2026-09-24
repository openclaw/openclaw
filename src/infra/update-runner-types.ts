import type { z } from "zod";
import type { PluginUpdateOutcome } from "../plugins/update.js";
import type { CommandOptions } from "../process/exec.js";
import type { UpdateRecoveryStep } from "../shared/update-outcome.js";
import type { OpenClawSchemaVersions } from "../state/openclaw-schema-versions.js";
import type { LocalPackageOverridesResult } from "./package-local-overrides.js";
import type { PackageUpdateTransaction } from "./package-update-swap-contract.js";
import type { UpdateChannel } from "./update-channels.js";
import type { DevUpdateTarget } from "./update-dev-target.js";
import type {
  UpdateDoctorConfigChange,
  UpdateDoctorConfigWriteRefusal,
} from "./update-doctor-config.js";
import type { UpdateDoctorLintFinding } from "./update-doctor-lint-schema.js";
import type { PackageUpdateStepAdvisory } from "./update-doctor-result.js";
import type { UpdateFailureFact } from "./update-failure-facts.js";
import type { GitRuntimeArtifactIdentity } from "./update-git-runtime.js";
import type { GlobalInstallManager } from "./update-global.js";
import type { UpdateRecovery } from "./update-recovery.js";
import type { UpdateRollbackOutcome, UpdateRunRecordSchema } from "./update-run-schema.js";
import type { UpdateSnapshotCapacity } from "./update-snapshot-capacity.js";

type UpdateStepAdvisory =
  | PackageUpdateStepAdvisory
  | { kind: "candidate-runtime-unavailable" | "recoverable-maintenance"; message: string };

export type UpdateStepResult = {
  /** Stable public identifier; released recovery keys retain their persisted spelling. */
  name: string;
  command: string;
  cwd: string;
  durationMs: number;
  exitCode: number | null;
  stdoutTail?: string | null;
  stderrTail?: string | null;
  signal?: NodeJS.Signals | null;
  killed?: boolean;
  outputLimitExceeded?: boolean;
  termination?: "exit" | "timeout" | "no-output-timeout" | "signal";
  advisory?: UpdateStepAdvisory;
  /** Complete owner-classified warnings when one step reports several outcomes. */
  warnings?: string[];
  /** Owner-selected informational messages, retained separately from warnings and raw output. */
  diagnostics?: string[];
  /** Suggested operator actions, distinct from executed update steps. */
  recoverySteps?: readonly UpdateRecoveryStep[];
  failureFacts?: UpdateFailureFact[];
  doctorLintFindings?: UpdateDoctorLintFinding[];
  configChanges?: UpdateDoctorConfigChange[];
  configWriteRefusal?: UpdateDoctorConfigWriteRefusal;
  snapshotCapacity?: UpdateSnapshotCapacity;
};

export type UpdateRunResult = {
  localOverrides?: LocalPackageOverridesResult;
  runId?: string;
  status: "ok" | "error" | "skipped";
  mode: "git" | "pnpm" | "bun" | "npm" | "unknown";
  root?: string;
  reason?: string;
  /** The executing owner's terminal failure; steps also retain superseded attempts. */
  failedStep?: UpdateStepResult;
  gitRuntime?: GitRuntimeArtifactIdentity;
  before?: { sha?: string | null; version?: string | null; buildId?: string | null };
  after?: {
    sha?: string | null;
    version?: string | null;
    buildId?: string | null;
    upstreamRef?: string;
  };
  steps: UpdateStepResult[];
  durationMs: number;
  recovery?: UpdateRecovery;
  verification?: Omit<
    z.infer<typeof UpdateRunRecordSchema>["verification"],
    "recovery" | "rollbackOutcome"
  >;
  rollbackOutcome?: UpdateRollbackOutcome;
  postUpdate?: {
    plugins?: {
      failureFacts?: UpdateFailureFact[];
      doctorLint?: UpdateStepResult;
      status: "ok" | "warning" | "skipped" | "error";
      reason?: string;
      changed: boolean;
      warnings?: Array<{
        pluginId?: string;
        source?: string;
        errorCode?: string;
        reason: string;
        message: string;
        guidance: string[];
      }>;
      sync: {
        changed: boolean;
        switchedToBundled: string[];
        switchedToNpm: string[];
        warnings: string[];
        errors: string[];
      };
      npm: {
        changed: boolean;
        outcomes: PluginUpdateOutcome[];
      };
      integrityDrifts: Array<{
        pluginId: string;
        spec: string;
        expectedIntegrity: string;
        actualIntegrity: string;
        resolvedSpec?: string;
        resolvedVersion?: string;
        action: "aborted";
      }>;
    };
  };
};

export type CommandRunner = (
  argv: string[],
  options: CommandOptions,
) => Promise<{
  stdout: string;
  stderr: string;
  code: number | null;
  signal?: NodeJS.Signals | null;
  killed?: boolean;
  outputLimitExceeded?: boolean;
  termination?: "exit" | "timeout" | "no-output-timeout" | "signal";
}>;

export type UpdateStepInfo = {
  name: string;
  command: string;
  index: number;
  total: number;
};

type UpdateStepCompletion = UpdateStepInfo & Omit<UpdateStepResult, "cwd">;

export type UpdateStepProgress = {
  onRollbackOutcome?: (outcome: NonNullable<UpdateRunResult["rollbackOutcome"]>) => void;
  onHeartbeat?: () => void;
  onStepStart?: (step: UpdateStepInfo) => void;
  onStepComplete?: (step: UpdateStepCompletion) => void;
};

type GitUpdateTarget = {
  sha?: string;
  version?: string;
  schemaVersions?: OpenClawSchemaVersions;
  metadataUnreadable?: string;
};

export type UpdateRunnerOptions = {
  channel?: UpdateChannel;
  devTarget?: DevUpdateTarget;
  /** Expose a new checkout only after target admission; subsequent work uses the published path. */
  publishGitCheckout?: () => Promise<string>;
  /** Owns preflight artifact storage when publication moves a newly cloned checkout. */
  gitArtifactStorageRoot?: string;
  /** Read-only admission before executing a fetched candidate; never stops a service. */
  inspectGitTarget: (target: GitUpdateTarget) => Promise<void>;
  /** Admit required preparation after no-op detection, before allocating the candidate worktree. */
  beforeGitStaging?: () => Promise<{ step: UpdateStepResult; failureReason: string }>;
  validateCandidate: (root: string) => Promise<void>;
  beforeGitMutation: (target: GitUpdateTarget) => Promise<void>;
  /** Operator-selected work deadline; omission leaves work unbounded, not probes or cleanup. */
  timeoutMs?: number;
  progress?: UpdateStepProgress;
  /** The finalizer owns retained source/runtime rollback after successful activation. */
  onTransaction?: (transaction: PackageUpdateTransaction) => void;
} & (
  | {
      /** CLI-owned activation Doctor retains its config writer and requester authority. */
      runGitDoctor: (
        root: string,
        results?: UpdateStepResult[],
      ) => Promise<UpdateStepResult | null>;
      prepareGitExposure?: never;
    }
  | {
      runGitDoctor?: never;
      prepareGitExposure: (
        candidateRoot: string,
        candidateSha: string,
        env: NodeJS.ProcessEnv | undefined,
      ) => Promise<void>;
    }
);

export type UpdateInstallSurface =
  | { kind: "git"; mode: "git"; root: string; packageRoot: string }
  | { kind: "global"; mode: GlobalInstallManager; root: string; packageRoot: string }
  | { kind: "package-root"; mode: "unknown"; root: string; packageRoot: string }
  | { kind: "missing"; mode: "unknown"; root?: string; packageRoot?: undefined };

export type RunStepOptions = {
  runCommand: CommandRunner;
  name: string;
  argv: string[];
  cwd: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  progress?: UpdateStepProgress;
  stepIndex: number;
  totalSteps: number;
  results?: UpdateStepResult[];
};
