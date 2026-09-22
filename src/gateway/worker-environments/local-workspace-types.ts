import type { ManagedWorktreeRecord } from "../../agents/worktrees/types.js";

export type LocalWorkspaceOwner = {
  agentId: string;
  sessionKey: string;
  sessionId: string;
  lifecycleRevision: string | null;
  worktree: ManagedWorktreeRecord;
  assertCurrent: () => void;
  env?: NodeJS.ProcessEnv;
};
