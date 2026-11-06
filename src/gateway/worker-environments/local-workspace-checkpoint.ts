import { timeWorktreePreparationPhase } from "../../agents/worktrees/preparation-timing.js";
import { hasErrnoCode } from "../../infra/errno.js";
import { assertLocalWorkspaceDirectory } from "./local-workspace-checkout.js";
import type { LocalWorkspaceManifestCheckpoint } from "./local-workspace-manifest-scan.js";
import type { LocalWorkspaceProjection } from "./local-workspace-store.types.js";
import { isLocalWorkspaceBaseRefreshRef } from "./workspace-result-inventory.js";
import { workerWorkspaceResultStaging } from "./workspace-result-staging.js";

export type LocalWorkspaceSyncTarget = "canonical" | "projection";
class UnstagedWorkspacePathError extends Error {}

export function pendingLocalWorkspaceDirection(
  value: string | null,
): LocalWorkspaceSyncTarget | undefined {
  return value === "canonical" || value === "projection" ? value : undefined;
}

export function selectLocalWorkspaceCheckpoint(
  selected: LocalWorkspaceProjection,
  pendingRef: string,
) {
  const target = pendingLocalWorkspaceDirection(selected.pending_target);
  if (!selected.baseline_ref || !target) {
    throw new Error("Local workspace result has no accepted baseline");
  }
  return { target, refresh: isLocalWorkspaceBaseRefreshRef(pendingRef) };
}

export async function stageLocalWorkspaceCheckpoint(
  params: Parameters<typeof workerWorkspaceResultStaging.stageWorkerWorkspaceResult>[0],
  custody: {
    target: LocalWorkspaceSyncTarget;
    refresh: boolean;
    snapshot: LocalWorkspaceManifestCheckpoint | undefined;
    current: () => LocalWorkspaceProjection;
    signal: AbortSignal;
  },
) {
  try {
    return await workerWorkspaceResultStaging.stageWorkerWorkspaceResult(params);
  } catch (error) {
    custody.signal.throwIfAborted();
    const retained = custody.current();
    if (
      error instanceof Error &&
      hasErrnoCode(error, "WORKSPACE_STAGE_CURRENT_PATH_UNSAFE") &&
      custody.target === "canonical" &&
      !custody.refresh &&
      custody.snapshot?.previousRoot === retained.baseline_ref &&
      retained.pending_ref === params.stagedResultRef &&
      retained.pending_target === "canonical" &&
      !retained.journal_json
    ) {
      // The caller proved no result ref exists. Keep its reservation and
      // accepted baseline; only preparation may reuse these unstaged bytes.
      throw new UnstagedWorkspacePathError(error.message, { cause: error });
    }
    throw error;
  }
}

export async function prepareLocalWorkspaceCheckpoint(params: {
  baselineRef: string | null;
  synchronize: (target: LocalWorkspaceSyncTarget) => Promise<void>;
  current: () => LocalWorkspaceProjection;
  signal: AbortSignal;
}) {
  await assertLocalWorkspaceDirectory(params.current().projection_path);
  if (params.baselineRef) {
    try {
      await timeWorktreePreparationPhase("synchronizeCanonical", () =>
        params.synchronize("canonical"),
      );
    } catch (error) {
      if (!(error instanceof UnstagedWorkspacePathError)) {
        throw error;
      }
      // An authorized turn can correct its retained files. Do not import newer
      // canonical state over them or report the failed checkpoint as accepted.
      params.signal.throwIfAborted();
      return params.current().projection_path;
    }
  }
  await timeWorktreePreparationPhase("synchronizeProjection", () =>
    params.synchronize("projection"),
  );
  return params.current().projection_path;
}
