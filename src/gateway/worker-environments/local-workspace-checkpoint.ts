import { randomUUID } from "node:crypto";
import { timeWorktreePreparationPhase } from "../../agents/worktrees/preparation-timing.js";
import { hasErrnoCode } from "../../infra/errno.js";
import { assertLocalWorkspaceDirectory } from "./local-workspace-checkout.js";
import type { LocalWorkspaceManifestCheckpoint } from "./local-workspace-manifest-scan.js";
import type { LocalWorkspaceStore } from "./local-workspace-store.js";
import type {
  LocalWorkspaceProjection,
  LocalWorkspaceRejectedResult,
} from "./local-workspace-store.types.js";
import { isLocalWorkspaceBaseRefreshRef } from "./workspace-result-inventory.js";
import {
  workerWorkspaceResultRef,
  workerWorkspaceResultStaging,
} from "./workspace-result-staging.js";

export type LocalWorkspaceSyncTarget = "canonical" | "projection";
class UnstagedWorkspacePathError extends Error {}

class RejectedLocalWorkspaceResultError extends Error {
  constructor(
    message: string,
    readonly repairable: boolean,
  ) {
    super(message);
  }
}

export function createLocalWorkspaceCheckpointRejection(params: {
  current: () => LocalWorkspaceProjection;
  removedAt: number | undefined;
  update: (patch: Parameters<LocalWorkspaceStore["update"]>[1]) => Promise<void>;
  reject: (
    selected: LocalWorkspaceProjection,
    rejection: Omit<LocalWorkspaceRejectedResult, "ref">,
  ) => Promise<void>;
}) {
  const repairTarget = (selected: LocalWorkspaceProjection) =>
    !isLocalWorkspaceBaseRefreshRef(selected.pending_ref) && params.removedAt === undefined
      ? pendingLocalWorkspaceDirection(selected.pending_target)
      : undefined;
  const rejection = (reason: string) => {
    const selected = params.current();
    return new RejectedLocalWorkspaceResultError(reason, repairTarget(selected) === "canonical");
  };
  const assertNotRejected = () => {
    const selected = params.current();
    if (selected.rejectedResult) {
      throw rejection(selected.rejectedResult.reason);
    }
    return selected;
  };
  return {
    assertNotRejected,
    settle: async (run: () => Promise<void>, manifestRef?: string) => {
      assertNotRejected();
      try {
        await run();
      } catch (error) {
        if (!(error instanceof Error) || !hasErrnoCode(error, "WORKSPACE_RESULT_LIMIT")) {
          throw error;
        }
        const selected = params.current();
        if (selected.pending_ref && selected.pending_target && !selected.journal_json) {
          const reason =
            error.message +
            " Pending workspace changes were preserved. Move disposable build outputs to checkout-root .openclaw/tmp/ or remove unneeded outputs" +
            (selected.pending_target === "projection"
              ? " in the canonical workspace, then retry workspace preparation."
              : ", then checkpoint the corrected workspace.");
          await params.reject(selected, { reason, manifestRef });
          throw rejection(reason);
        }
        throw error;
      }
    },
    synchronize: async (input: {
      target: LocalWorkspaceSyncTarget;
      captureRejected?: true;
      settle: (
        retainAccepted?: boolean,
        snapshot?: LocalWorkspaceManifestCheckpoint,
      ) => Promise<void>;
      scan: (target: LocalWorkspaceSyncTarget) => Promise<LocalWorkspaceManifestCheckpoint>;
    }) => {
      const selected = params.current();
      const rejected = selected.rejectedResult;
      const replacedRejected = Boolean(
        input.captureRejected && rejected && input.target === repairTarget(selected),
      );
      if (!replacedRejected) {
        await input.settle();
      }
      // Only changed source files can replace rejection. Its Git ref and guest
      // files remain recoverable; background settlement never retries it.
      const snapshot = await input.scan(input.target);
      if (replacedRejected && rejected && snapshot.currentManifestRef === rejected.manifestRef) {
        throw rejection(rejected.reason);
      }
      if (snapshot.resultingRoot !== snapshot.previousRoot) {
        await params.update({
          pending_ref: workerWorkspaceResultRef(randomUUID()),
          pending_target: input.target,
          checkpoint_json: JSON.stringify(snapshot),
        });
        await input.settle(false, snapshot);
      } else if (replacedRejected) {
        await params.update({ pending_ref: null, pending_target: null, checkpoint_json: null });
      }
    },
  };
}

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
  synchronize: (
    target: LocalWorkspaceSyncTarget,
    options?: { captureRejected?: true },
  ) => Promise<void>;
  current: () => LocalWorkspaceProjection;
  signal: AbortSignal;
}) {
  await assertLocalWorkspaceDirectory(params.current().projection_path);
  const selected = params.current();
  if (selected.rejectedResult && selected.pending_target === "projection") {
    // Preparation can import a corrected host source before exporting guest edits.
    await params.synchronize("projection", { captureRejected: true });
  }
  if (params.baselineRef) {
    try {
      await timeWorktreePreparationPhase("synchronizeCanonical", () =>
        params.synchronize("canonical"),
      );
    } catch (error) {
      if (
        !(error instanceof UnstagedWorkspacePathError) &&
        !(error instanceof RejectedLocalWorkspaceResultError && error.repairable)
      ) {
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
