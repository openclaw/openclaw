import type { CommandOptions } from "../process/exec.js";
import type { OpenClawSchemaVersions } from "../state/openclaw-schema-versions.js";
import type { PackageUpdateTransaction } from "./package-update-swap-contract.js";
import type { UpdateChannel } from "./update-channels.js";
import type { DevUpdateTarget } from "./update-dev-target.js";
import type { GlobalInstallManager } from "./update-global.js";
import type { UpdateRunResult } from "./update-run-result.js";
import type { UpdateStepResult } from "./update-step-result.js";

export type { UpdateRunResult } from "./update-run-result.js";

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
