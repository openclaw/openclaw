import { z } from "zod";
import type { SessionDiffFile } from "../../../packages/gateway-protocol/src/index.js";
import { EMPTY_WORKTREE_INITIAL_COMMIT_ID } from "../../agents/worktrees/empty-source-identity.js";
import { workerProtocolObject } from "../../worker/protocol-record.js";
import type { WorkspaceReconciliationPreparation } from "./workspace-manifest-comparison.js";
import type {
  WorkerWorkspaceManifest,
  WorkerWorkspaceManifestEntry,
} from "./workspace-manifest.js";

export const WorkerWorkspaceGitHistorySchema = workerProtocolObject({
  baseCommit: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u),
  headCommit: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u),
  descendsFromBase: z.boolean(),
  unavailableReason: z.string().max(512).optional(),
});
export type WorkerWorkspaceGitHistory = z.infer<typeof WorkerWorkspaceGitHistorySchema>;

// Deleting the owning ref releases its objects to ordinary Git garbage collection.
export const WORKER_RESULT_REF_PREFIX = "refs/openclaw/worker-results";
export const WORKER_RESULT_CANDIDATE_REF_PREFIX = "refs/openclaw/worker-result-candidates";
export const WORKER_RESULT_CLEANUP_REF_PREFIX = "refs/openclaw/worker-result-cleanup";
export const STAGED_RESULT_MESSAGE = "OpenClaw worker workspace result";

/** The current manifest was rejected before writing import input or publishing a result ref. */
export class WorkspaceStageCurrentPathError extends Error {
  readonly code = "WORKSPACE_STAGE_CURRENT_PATH_UNSAFE";
}

const BASE_REFRESH_REF_PREFIX = "refs/openclaw/workspace-base-refresh";
const BASE_REFRESH_REF = /^refs\/openclaw\/workspace-base-refresh\/[a-f0-9]{64}$/u;

export function localWorkspaceBaseRefreshRef(identity: string): string {
  const ref = `${BASE_REFRESH_REF_PREFIX}/${identity}`;
  if (!isLocalWorkspaceBaseRefreshRef(ref)) {
    throw new Error("Workspace base refresh result identity is invalid");
  }
  return ref;
}

export function isLocalWorkspaceBaseRefreshRef(ref: string | null): boolean {
  return ref !== null && BASE_REFRESH_REF.test(ref);
}

/** Only the host-owned first import establishes a repository rather than editing one. */
export function isInitialWorkspaceSourceImport(
  ref: string,
  base: WorkerWorkspaceManifest,
  current: WorkerWorkspaceManifest,
): boolean {
  return (
    isLocalWorkspaceBaseRefreshRef(ref) &&
    base.baseCommit === EMPTY_WORKTREE_INITIAL_COMMIT_ID &&
    base.entries.length === 0 &&
    current.baseCommit !== null &&
    current.baseCommit !== base.baseCommit
  );
}

export function requireWorkerResultStorageRef(ref: string): string {
  if (
    !new RegExp(
      `^(?:${WORKER_RESULT_REF_PREFIX}|${WORKER_RESULT_CANDIDATE_REF_PREFIX}|${WORKER_RESULT_CLEANUP_REF_PREFIX})/[A-Za-z0-9-]+$`,
      "u",
    ).test(ref) &&
    // Earlier readers refuse this purpose before applying a one-copy result.
    !isLocalWorkspaceBaseRefreshRef(ref)
  ) {
    throw new Error("Cloud workspace staged result reference is invalid");
  }
  return ref;
}

export type StagedWorkerWorkspaceInventory = {
  gitHistory?: WorkerWorkspaceGitHistory;
  baseManifestRaw: string;
  currentManifestRaw: string;
  baseManifestRef: string;
  currentManifestRef: string;
  base: WorkerWorkspaceManifest;
  current: WorkerWorkspaceManifest;
  reconciliation: WorkspaceReconciliationPreparation;
  changed: boolean;
  changedEntries: WorkerWorkspaceManifestEntry[];
  objectsByPath: Map<string, { mode: string; objectId: string }>;
};

export type StagedWorkerWorkspaceResult = Pick<
  StagedWorkerWorkspaceInventory,
  "gitHistory" | "baseManifestRef" | "currentManifestRef" | "changed"
> & {
  base: Pick<WorkerWorkspaceManifest, "baseCommit">;
  current: Pick<WorkerWorkspaceManifest, "baseCommit">;
  changedEntryCount: number;
};

export const STAGED_WORKSPACE_READ_MAX_ENTRIES = 256;
// A single accepted file can be 64 MiB; the same hard ceiling applies to every batch.
export const STAGED_WORKSPACE_READ_MAX_BYTES = 64 * 1024 * 1024;

export type StagedWorkerWorkspaceReadEntry = {
  object: { mode: string; objectId: string };
  entry: WorkerWorkspaceManifestEntry;
};

export function stagedWorkspaceEntryBytes(entry: WorkerWorkspaceManifestEntry): number {
  return entry.type === "file" ? entry.size : Buffer.byteLength(entry.target);
}

export function resolveStagedWorkspaceReadEntry(
  objectsByPath: StagedWorkerWorkspaceInventory["objectsByPath"],
  entry: WorkerWorkspaceManifestEntry,
): StagedWorkerWorkspaceReadEntry {
  const object = objectsByPath.get(entry.path);
  if (!object) {
    throw new Error(`Cloud workspace result has no payload for ${entry.path}`);
  }
  return { object, entry };
}

export type StagedWorkerArtifactInventory = {
  baseManifestRef: string;
  currentManifestRef: string;
  base: Pick<WorkerWorkspaceManifest, "baseCommit">;
  current: Pick<WorkerWorkspaceManifest, "baseCommit">;
  changedEntries: WorkerWorkspaceManifestEntry[];
  changes: SessionDiffFile[];
  preview?: Uint8Array;
  downloadObjectId?: string;
};

export type WorkspaceArtifactReadOperations = {
  "workspace.artifacts": {
    input: { root: string; ref: string; previewPath?: string; downloadPath?: string };
    output: StagedWorkerArtifactInventory;
  };
};
