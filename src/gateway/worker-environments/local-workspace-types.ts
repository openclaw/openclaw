import type {
  ManagedWorktreeRecord,
  WorktreeWorkerAuthority,
} from "../../agents/worktrees/types.js";

export type LocalWorkspaceOwner = {
  agentId: string;
  sessionKey: string;
  sessionId: string;
  lifecycleRevision: string | null;
  worktree: ManagedWorktreeRecord;
  /** Complete effect authority, including any allocation or caller authority in workerAuthority. */
  assertCurrent: () => void;
  workerAuthority?: WorktreeWorkerAuthority;
  env?: NodeJS.ProcessEnv;
};
