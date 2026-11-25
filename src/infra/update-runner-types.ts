import type { SpawnResult } from "../process/exec-result.js";
import type { CommandOptions } from "../process/exec.js";
import type { OpenClawSchemaVersions } from "../state/openclaw-schema-versions.js";
import type { UpdateChannel } from "./update-channels.js";
import type { DevUpdateTarget } from "./update-dev-target.js";
import type { GlobalInstallManager } from "./update-global.js";
import type { UpdateStepResult } from "./update-step-result.js";

export type { UpdateRunResult } from "./update-run-result.js";

export type CommandRunner = (
  argv: string[],
  options: CommandOptions,
) => Promise<
  Pick<SpawnResult, "stdout" | "stderr" | "code" | "outputLimitExceeded"> &
    Partial<Pick<SpawnResult, "signal" | "killed" | "termination">>
>;

export type UpdateStepInfo = {
  name: string;
  command: string;
  index: number;
  total: number;
};

type UpdateStepCompletion = UpdateStepInfo & Omit<UpdateStepResult, "cwd">;

export type UpdateStepProgress = {
  onHeartbeat?: () => void;
  onStepStart?: (step: UpdateStepInfo) => void | Promise<void>;
  onStepComplete?: (step: UpdateStepCompletion) => void | Promise<void>;
};

type GitUpdateTarget = {
  sha?: string;
  version?: string;
  schemaVersions?: OpenClawSchemaVersions;
  databaseEngines?: unknown;
  postgresFamilies?: unknown;
  metadataUnreadable?: string;
};

export type UpdateRunnerOptions = {
  channel?: UpdateChannel;
  devTarget?: DevUpdateTarget;
  /** Read-only admission before executing a fetched candidate; never stops a service. */
  inspectGitTarget: (target: GitUpdateTarget) => Promise<void>;
  /** Accepted candidate checks join the update's step results. */
  validateCandidate: (root: string) => Promise<readonly UpdateStepResult[] | void>;
  beforeGitMutation: (target: GitUpdateTarget) => Promise<void>;
  /** `--no-restart`: the next service start selects the release instead of this update. */
  deferReleaseActivation?: boolean;
  /** The service's Node, which must load a Git release before the link names it. */
  releaseNode?: string;
  /** Required work uses the caller's deadline; probes, cleanup, and optional replay keep finite defaults. */
  timeoutMs?: number;
  progress?: UpdateStepProgress;
};

export type UpdateInstallSurface =
  | { kind: "immutable"; mode: "unknown"; root: string; packageRoot: string }
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
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  input?: string;
  progress?: UpdateStepProgress;
  stepIndex: number;
  totalSteps: number;
  results?: UpdateStepResult[];
};
