import type {
  ManagedWorktreeRecord,
  WorktreeWorkerAuthority,
} from "../../agents/worktrees/types.js";

export type LocalWorkspaceCapture = {
  root: string;
  sourceDev: bigint;
  snapshotDev: bigint;
  capturedAtMs: number;
};

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

export type LocalWorkspaceCustody = {
  worktreeId: string;
  projectionPath?: string;
  projectionRevision?: number;
  prepareArchive?: (snapshot: string) => Promise<void>;
  canonicalPaths?: () => Promise<Set<string>>;
  synchronizeProjection?: () => Promise<void>;
  assertCurrent: () => void;
  workerAuthority: WorktreeWorkerAuthority;
};
