import type {
  GitWorktreeEffects,
  GitWorktreeOperations,
} from "../agents/worktrees/git-worktree-operations.js";
import type {
  WorkspaceInventoryComputationOperations,
  WorkspaceInventoryHostEffects,
} from "../gateway/worker-environments/workspace-inventory-computation.js";
import type { WorkspaceManifestComputationOperations } from "../gateway/worker-environments/workspace-manifest-computation.js";
import type { WorkspaceArtifactReadOperations } from "../gateway/worker-environments/workspace-result-inventory.js";
import type { BufferedCommandOptions, BufferedCommandResult } from "../process/exec.js";
import type { GitCommandBytesResult, GitCommandOptions } from "./git-exec.js";
import type { GitReadOperations } from "./git-read-operations.js";

export type GitWorkerOperations = GitReadOperations &
  GitWorktreeOperations &
  WorkspaceArtifactReadOperations &
  WorkspaceInventoryComputationOperations &
  WorkspaceManifestComputationOperations;
export type GitWorkerCommand = {
  [K in keyof GitWorkerOperations]: {
    type: K;
    input: GitWorkerOperations[K]["input"];
    filesystemRefs?: boolean;
  };
}[keyof GitWorkerOperations];
export type GitWorkerResult = GitWorkerOperations[keyof GitWorkerOperations]["output"];

export type GitWorkerEffects = GitWorktreeEffects &
  WorkspaceInventoryHostEffects & {
    "git.temporary-directory": { input: Record<string, never>; output: string };
  };
export type GitWorkerEffect = {
  [K in keyof GitWorkerEffects]: { type: K; input: GitWorkerEffects[K]["input"] };
}[keyof GitWorkerEffects];
type GitWorkerTextOptions = Omit<GitCommandOptions, "signal" | "beforeRun">;
type GitWorkerBufferOptions = Omit<BufferedCommandOptions, "signal">;
export type GitWorkerGitCommands = {
  "git.text": {
    input: { cwd: string; args: string[]; options: GitWorkerTextOptions };
    output: GitCommandBytesResult;
  };
  "git.buffer": {
    input: { cwd: string; args: string[]; options: GitWorkerBufferOptions };
    output: BufferedCommandResult;
  };
};
export type GitWorkerGitCommand = {
  [K in keyof GitWorkerGitCommands]: { type: K; input: GitWorkerGitCommands[K]["input"] };
}[keyof GitWorkerGitCommands];
export type GitWorkerHostRequest = GitWorkerGitCommand | GitWorkerEffect;
export type GitWorkerHostBatch = { type: "git.batch"; input: { requests: GitWorkerHostRequest[] } };
export const GIT_WORKER_HOST_BATCH_LIMIT = 16;

export type GitWorkerFailure = {
  name: string;
  message: string;
  code?: string | number;
  origin?: number;
};
export type GitWorkerReply<T> = { ok: true; value: T } | { ok: false; error: GitWorkerFailure };
