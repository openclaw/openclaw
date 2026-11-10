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
import { loadStagedWorkspaceManifest } from "./workspace-manifest-worker.js";
import {
  isInitialWorkspaceSourceImport,
  isLocalWorkspaceBaseRefreshRef,
} from "./workspace-result-inventory.js";
import {
  deleteStagedWorkerWorkspaceResult,
  workerWorkspaceResultRef,
  workerWorkspaceResultStaging,
} from "./workspace-result-staging.js";

export type LocalWorkspaceSyncTarget = "canonical" | "projection";
class UnstagedWorkspacePathError extends Error {}

export class RejectedLocalWorkspaceResultError extends Error {
  constructor(
    message: string,
    readonly repairable: boolean,
    readonly resultRef: string | null,
    readonly projectionPath: string,
  ) {
    super(message);
  }
}

export function createLocalWorkspaceCheckpointOperations(params: {
  current: () => LocalWorkspaceProjection;
  removedAt: number | undefined;
  root: string;
  repoRoot: string;
  signal: AbortSignal;
  buildCacheInputs: () => Promise<string[]>;
  baselineDocument: () => Promise<{ manifestRef: string }>;
  settlePending: (
    retainAccepted: boolean,
    snapshot?: LocalWorkspaceManifestCheckpoint,
  ) => Promise<void>;
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
    return new RejectedLocalWorkspaceResultError(
      reason,
      repairTarget(selected) === "canonical",
      selected.pending_ref,
      selected.projection_path,
    );
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
    cleanupAccepted: async () => {
      const selected = params.current();
      if (!selected.pending_ref || selected.pending_target) {
        return;
      }
      await deleteStagedWorkerWorkspaceResult({
        root: params.repoRoot,
        stagedResultRef: selected.pending_ref,
        assertCurrent: () => void params.current(),
      });
      await params.update({
        pending_ref: null,
        checkpoint_json: null,
        ...(selected.tree_root_digest ? { baseline_json: null } : {}),
      });
    },
    settle: async (retainAccepted = false, snapshot?: LocalWorkspaceManifestCheckpoint) => {
      const pending = params.current();
      if (
        pending.rejectedResult &&
        pending.pending_ref &&
        pending.rejectedResult.ref === pending.pending_ref &&
        isLocalWorkspaceBaseRefreshRef(pending.pending_ref)
      ) {
        const source = await loadStagedWorkspaceManifest(
          params.root,
          pending.pending_ref,
          params.signal,
          await params.buildCacheInputs(),
        );
        const baseline = await params.baselineDocument();
        if (
          source.baseManifestRef === baseline.manifestRef &&
          isInitialWorkspaceSourceImport(pending.pending_ref, source.base, source.current) &&
          (!pending.rejectedResult.manifestRef ||
            pending.rejectedResult.manifestRef === source.currentManifestRef)
        ) {
          // Older releases rejected the initial repository as a giant edit. Resume
          // that same validated source, preserving its ref and saved checkpoint.
          await params.update({ checkpoint_json: pending.checkpoint_json });
        }
      }
      assertNotRejected();
      try {
        await params.settlePending(retainAccepted, snapshot);
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
          await params.reject(selected, { reason, manifestRef: snapshot?.currentManifestRef });
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
      if (
        replacedRejected &&
        rejected &&
        (snapshot.currentManifestRef === rejected.manifestRef ||
          snapshot.resultingRoot === rejected.manifestRef)
      ) {
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
