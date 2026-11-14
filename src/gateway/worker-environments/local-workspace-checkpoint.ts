import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { nativeWorktreeFilesystem } from "../../agents/worktrees/filesystem-native.js";
import { timeWorktreePreparationPhase } from "../../agents/worktrees/preparation-timing.js";
import {
  captureWorktreeRunEndContext,
  withWorktreeRunEnd,
} from "../../agents/worktrees/run-end-lifecycle.js";
import { observeDiagnosticsTimelinePhases } from "../../infra/diagnostics-timeline.js";
import { hasErrnoCode } from "../../infra/errno.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { assertLocalWorkspaceDirectory } from "./local-workspace-checkout.js";
import type { LocalWorkspaceManifestCheckpoint } from "./local-workspace-manifest-scan.js";
import type { LocalWorkspaceStore } from "./local-workspace-store.js";
import type {
  LocalWorkspaceProjection,
  LocalWorkspaceRejectedResult,
} from "./local-workspace-store.types.js";
import type { LocalWorkspaceCapture } from "./local-workspace-types.js";
import { AcceptedWorkspacePublicationIndeterminateError } from "./workspace-accepted-publication.js";
import { serializeWorkerWorkspaceReconciliationPlan } from "./workspace-manifest.js";
import type { applyStagedWorkerWorkspace } from "./workspace-reconcile-apply.js";
import { isLocalWorkspaceBaseRefreshRef } from "./workspace-result-inventory.js";
import {
  workerWorkspaceResultRef,
  workerWorkspaceResultStaging,
} from "./workspace-result-staging.js";

export type LocalWorkspaceSyncTarget = "canonical" | "projection";
export type LocalWorkspaceSyncOptions = {
  captureRejected?: true;
  afterCapture?: () => Promise<void>;
  capture?: (run: (source?: LocalWorkspaceCapture) => Promise<void>) => Promise<void>;
};

export type LocalWorkspaceCaptureDiagnostics = {
  reason:
    | "adaptive-direct"
    | "btrfs"
    | "non-subvolume"
    | "btrfs-unavailable"
    | "clone-unavailable"
    | "nested-incomplete";
  cloneError?: "CLONE_UNAVAILABLE" | "EXDEV" | "ENOSYS";
  pausedAt?: number;
  preCopyMs?: number;
  copyMs?: number;
  postCopyBeforeResumeMs?: number;
  resumeMs?: number;
};

type CaptureOptions = Parameters<typeof nativeWorktreeFilesystem.remove>[1] & {
  env?: NodeJS.ProcessEnv;
};
const pendingCaptureRemovals = resolveGlobalSingleton(
  Symbol.for("openclaw.localWorkspaceCaptureRemovals"),
  () => new Map<string, Promise<void>>(),
);
const log = createSubsystemLogger("agents/worktrees");

function captureRemovalOwner(projectionPath: string, env?: NodeJS.ProcessEnv) {
  const context = captureWorktreeRunEndContext(env ?? process.env);
  return {
    context,
    key: JSON.stringify([context.admission.coordinationKey, projectionPath]),
  };
}

/** The lease transfers this immutable, disposable capture to the existing run-end owner. */
export async function retireLocalWorkspaceCheckpointCapture(
  projectionPath: string,
  options: CaptureOptions,
) {
  const parent = path.dirname(projectionPath);
  const retired = path.join(parent, `checkpoint-retired-${randomUUID()}`);
  options.signal?.throwIfAborted();
  options.commitGuard();
  try {
    await fs.rename(path.join(parent, "checkpoint-capture"), retired);
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return;
    }
    throw error;
  }
  options.commitGuard();
  const { context, key } = captureRemovalOwner(projectionPath, options.env);
  // Unique names prevent a delayed child from deleting a later checkpoint.
  // Caller cancellation cannot revoke an already transferred artifact.
  const pending = withWorktreeRunEnd(
    context.environment,
    () =>
      nativeWorktreeFilesystem.remove(retired, {
        commitGuard: context.admission.assertCurrent,
      }),
    { independent: true },
  );
  pendingCaptureRemovals.set(key, pending);
  void pending.then(
    () => pendingCaptureRemovals.delete(key),
    (error: unknown) => {
      pendingCaptureRemovals.delete(key);
      log.warn(`Local workspace checkpoint capture cleanup failed: ${String(error)}`);
    },
  );
}

async function finishRetiredCheckpointCaptures(projectionPath: string, options: CaptureOptions) {
  const { key } = captureRemovalOwner(projectionPath, options.env);
  // At most one retired capture per workspace. A failed or interrupted removal
  // must finish before a later snapshot can create another artifact.
  await pendingCaptureRemovals.get(key)?.catch(() => {});
  const parent = path.dirname(projectionPath);
  for (const name of await fs.readdir(parent)) {
    if (/^checkpoint-retired-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(name)) {
      await nativeWorktreeFilesystem.remove(path.join(parent, name), options);
    }
  }
}

export async function removeLocalWorkspaceCheckpointCapture(
  projectionPath: string,
  options: Parameters<typeof nativeWorktreeFilesystem.remove>[1],
) {
  const root = path.join(path.dirname(projectionPath), "checkpoint-capture");
  if (
    await fs.lstat(root).then(
      () => true,
      (error: unknown) => {
        if (hasErrnoCode(error, "ENOENT")) {
          return false;
        }
        throw error;
      },
    )
  ) {
    await nativeWorktreeFilesystem.remove(root, options);
  }
}

export async function prepareLocalWorkspaceCheckpointCapture(
  projectionPath: string,
  options: CaptureOptions,
  resume: () => Promise<void>,
  pause: () => Promise<void>,
  diagnostics: LocalWorkspaceCaptureDiagnostics,
): Promise<LocalWorkspaceSyncOptions["capture"]> {
  // The lease owns this sibling artifact, including leftovers from interrupted capture.
  await finishRetiredCheckpointCaptures(projectionPath, options);
  await removeLocalWorkspaceCheckpointCapture(projectionPath, options);
  const source = await fs.lstat(projectionPath, { bigint: true });
  if (source.ino !== 256n) {
    diagnostics.reason = "non-subvolume";
    return undefined;
  }
  if ((await nativeWorktreeFilesystem.probe(path.dirname(projectionPath), options)) !== "btrfs") {
    diagnostics.reason = "btrfs-unavailable";
    return undefined;
  }
  diagnostics.reason = "btrfs";
  const root = path.join(path.dirname(projectionPath), "checkpoint-capture");
  return async (run) => {
    const capturedAtMs = Date.now();
    const copyStarted = performance.now();
    diagnostics.preCopyMs =
      diagnostics.pausedAt === undefined ? undefined : copyStarted - diagnostics.pausedAt;
    let copyFinished: number;
    try {
      try {
        await nativeWorktreeFilesystem.copy(projectionPath, root, options);
      } finally {
        copyFinished = performance.now();
        diagnostics.copyMs = copyFinished - copyStarted;
      }
    } catch (error) {
      const code = (["CLONE_UNAVAILABLE", "EXDEV", "ENOSYS"] as const).find((value) =>
        hasErrnoCode(error, value),
      );
      if (!code) {
        throw error;
      }
      diagnostics.reason = "clone-unavailable";
      diagnostics.cloneError = code;
      await pause();
      await run();
      return;
    }
    const snapshot = await fs.lstat(root, { bigint: true });
    diagnostics.postCopyBeforeResumeMs = performance.now() - copyFinished;
    await resume();
    try {
      await run({ root, sourceDev: source.dev, snapshotDev: snapshot.dev, capturedAtMs });
    } catch (error) {
      if (!hasErrnoCode(error, "WORKSPACE_SNAPSHOT_INCOMPLETE")) {
        throw error;
      }
      // Btrfs omits nested subvolumes. No receipt was accepted; recapture the
      // complete live tree under the same lease using the durable Git path.
      diagnostics.reason = "nested-incomplete";
      await pause();
      await run();
    }
  };
}

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
    synchronize: async (
      input: LocalWorkspaceSyncOptions & {
        target: LocalWorkspaceSyncTarget;
        settle: (
          retainAccepted?: boolean,
          snapshot?: LocalWorkspaceManifestCheckpoint,
          afterCapture?: () => Promise<void>,
          source?: LocalWorkspaceCapture,
        ) => Promise<void>;
        scan: (
          target: LocalWorkspaceSyncTarget,
          source?: LocalWorkspaceCapture,
        ) => Promise<LocalWorkspaceManifestCheckpoint>;
      },
    ) => {
      const selected = params.current();
      const rejected = selected.rejectedResult;
      const replacedRejected = Boolean(
        input.captureRejected && rejected && input.target === repairTarget(selected),
      );
      if (!replacedRejected) {
        await input.settle();
      }
      const capture = async (source?: LocalWorkspaceCapture) => {
        // Only changed source files can replace rejection. Its Git ref and guest
        // files remain recoverable; background settlement never retries it.
        const snapshot = await input.scan(input.target, source);
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
          // Recovery above may import into the guest; only this new capture may resume it.
          await input.settle(false, snapshot, input.afterCapture, source);
        } else if (replacedRejected) {
          await params.update({ pending_ref: null, pending_target: null, checkpoint_json: null });
        }
      };
      await (input.capture ? input.capture(capture) : capture());
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
  operation: "prepare" | "reuse";
  baselineRef: string | null;
  synchronize: (
    target: LocalWorkspaceSyncTarget,
    options?: { captureRejected?: true },
  ) => Promise<void>;
  current: () => LocalWorkspaceProjection;
  signal: AbortSignal;
}) {
  const phase = `attempt.setup.sandbox.workspace_selection.${params.operation}.reconcile.checkpoint`;
  using phases = observeDiagnosticsTimelinePhases(`${phase}.directory`);
  await assertLocalWorkspaceDirectory(params.current().projection_path);
  const selected = params.current();
  if (selected.rejectedResult && selected.pending_target === "projection") {
    // Preparation can import a corrected host source before exporting guest edits.
    phases.mark(`${phase}.repair`);
    await params.synchronize("projection", { captureRejected: true });
  }
  if (params.baselineRef) {
    phases.mark(`${phase}.canonical`);
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
  phases.mark(`${phase}.projection`);
  await timeWorktreePreparationPhase("synchronizeProjection", () =>
    params.synchronize("projection"),
  );
  return params.current().projection_path;
}

export function createLocalWorkspaceCheckpointAcceptance(params: {
  current: () => LocalWorkspaceProjection;
  update: (
    patch: Parameters<LocalWorkspaceStore["update"]>[1],
    manifest?: Parameters<LocalWorkspaceStore["update"]>[3],
  ) => Promise<void>;
  replaceBaseline: (
    raw: string,
    ref: string,
    patch: Parameters<LocalWorkspaceStore["update"]>[1],
  ) => Promise<void>;
  checkpoint?: LocalWorkspaceManifestCheckpoint;
  target: LocalWorkspaceSyncTarget;
  refreshBaseCommit?: string;
  rawManifest: string;
  manifestRef: string;
  beforeCommit: () => void;
}): Pick<Parameters<typeof applyStagedWorkerWorkspace>[0], "journal" | "acceptance"> {
  let conflictPaths: string[] | undefined;
  return {
    journal: {
      load: async () => undefined,
      begin: async (journal) => {
        await params.update({
          journal_json: serializeWorkerWorkspaceReconciliationPlan(journal),
          journal_pack: journal.basePack,
        });
      },
      abort: async () => {
        await params.update({ journal_json: null, journal_pack: null });
      },
      commit: async () => {
        params.beforeCommit();
        if (!conflictPaths) {
          throw new Error("Local workspace acceptance is missing");
        }
        // A conflicting result remains a durable pending receipt. No guest
        // bytes are discarded or silently replaced by the canonical side.
        try {
          if (conflictPaths.length) {
            await params.update({ journal_json: null, journal_pack: null });
          } else if (params.refreshBaseCommit && params.target === "canonical") {
            await params.update({
              pending_target: "projection",
              journal_json: null,
              journal_pack: null,
            });
          } else {
            const patch = {
              ...(params.refreshBaseCommit ? { base_commit: params.refreshBaseCommit } : {}),
              pending_target: null,
              journal_json: null,
              journal_pack: null,
            };
            if (params.checkpoint) {
              await params.update(patch, params.checkpoint);
            } else {
              await params.replaceBaseline(params.rawManifest, params.manifestRef, patch);
            }
          }
        } catch (error) {
          throw new AcceptedWorkspacePublicationIndeterminateError("commit", error);
        }
      },
    },
    acceptance: {
      kind: "reconcile",
      publish: async (value) => {
        params.current();
        conflictPaths = value.conflictPaths;
      },
    },
  };
}
