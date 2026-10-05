import type { OpenClawConfig } from "../../config/config.js";
import type { WorktreeCleanupOwnerPolicy } from "./gc-removal.js";
import type {
  CreateManagedWorktreeParams,
  WorktreeWorkerAuthority,
  ManagedWorktreeGcResult,
} from "./types.js";

export type ServiceOptions = {
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  getConfig?: () => OpenClawConfig;
};

export type ManagedWorktreeGcParams = WorktreeCleanupOwnerPolicy &
  WorktreeMutationGuard & {
    checkpoint?: (progress: ManagedWorktreeGcResult) => Promise<void>;
  };

export type WorktreeMutationGuard = Pick<CreateManagedWorktreeParams, "signal" | "commitGuard"> & {
  workerAuthority?: WorktreeWorkerAuthority;
};

export type { RemoveWorktreeParams } from "./removal.js";
export type MaterializedRepositoryWorktree = {
  name: string;
  worktreePath: string;
  branch: string;
  recordBase: string;
  provisionedBytes: number;
  setupBytes: number;
  runRepositorySetup: boolean;
};
