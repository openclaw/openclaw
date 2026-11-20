import type { LocalWorkspacePausePhase } from "../../agents/sandbox/types.js";
import type {
  ManagedWorktreeRecord,
  WorktreeWorkerAuthority,
} from "../../agents/worktrees/types.js";
import type { LocalWorkspaceConflictRecord } from "./local-workspace-conflict-resolution.js";
import type { WorkspaceGuestVersion } from "./workspace-manifest-comparison.js";

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
  prepareArchive?: () => Promise<(snapshot: string) => Promise<void>>;
  canonicalPaths?: () => Promise<Set<string>>;
  /** Resume guest writes after settlement while retaining canonical workspace custody. */
  resume?: () => Promise<void>;
  synchronizeProjection?: () => Promise<void>;
  acknowledgeConflict?: (
    path: string,
    reviewedGuestVersion?: WorkspaceGuestVersion,
  ) => Promise<void>;
  conflicts?: LocalWorkspaceConflictRecord;
  markPhase?: (phase: LocalWorkspacePausePhase) => void;
  assertCurrent: () => void;
  workerAuthority: WorktreeWorkerAuthority;
};
