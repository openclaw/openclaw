import { z } from "zod";
import type { SessionDiffFile } from "../../../packages/gateway-protocol/src/index.js";
import { workerProtocolObject } from "../../worker/protocol-record.js";
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
  changed: boolean;
  changedEntries: WorkerWorkspaceManifestEntry[];
  objectsByPath: Map<string, { mode: string; objectId: string }>;
};

export const STAGED_WORKSPACE_READ_MAX_ENTRIES = 256;
export const STAGED_WORKSPACE_READ_MAX_BYTES = 8 * 1024 * 1024;

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
