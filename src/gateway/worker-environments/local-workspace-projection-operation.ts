import type {
  LocalWorkspacePauseReason,
  quiesceLocalWorkspace,
} from "../../agents/sandbox/local-workspace-quiescence.js";
import { timeWorktreePreparationPhase } from "../../agents/worktrees/preparation-timing.js";
import {
  prepareLocalWorkspaceCheckpointCapture,
  removeLocalWorkspaceCheckpointCapture,
  type LocalWorkspaceSyncOptions,
} from "./local-workspace-checkpoint.js";
import { projectionOperations } from "./local-workspace-state.js";
import type { LocalWorkspaceStore } from "./local-workspace-store.js";
import type { LocalWorkspaceOwner } from "./local-workspace-types.js";
import { workspaceSizeRecoveryPaths } from "./workspace-manifest-comparison.js";
import { isLocalWorkspaceBaseRefreshRef } from "./workspace-result-inventory.js";

export async function runLocalWorkspaceProjection<T>(
  owner: LocalWorkspaceOwner,
  store: LocalWorkspaceStore,
  run: (
    state: ReturnType<typeof projectionOperations>,
    quiescence?: Awaited<ReturnType<typeof quiesceLocalWorkspace>>,
    capture?: LocalWorkspaceSyncOptions["capture"],
  ) => Promise<T>,
  options: {
    provision?: boolean;
    reason?: LocalWorkspacePauseReason;
    afterAcceptance?: () => void;
    snapshotCapture?: boolean;
  } = {},
) {
  owner.assertCurrent();
  let previous = store.get();
  // A reset may recover its prior result; another session incarnation cannot adopt it.
  if (
    previous &&
    previous.session_id === owner.sessionId &&
    previous.session_key === owner.sessionKey &&
    previous.agent_id === owner.agentId &&
    previous.lifecycle_revision !== owner.lifecycleRevision
  ) {
    previous = await store.update(
      previous,
      { lifecycle_revision: owner.lifecycleRevision },
      owner.workerAuthority,
    );
  }
  const operations = projectionOperations(owner, store, previous);
  if (previous) {
    operations.current();
  }
  const { quiesceLocalWorkspace, parseLocalWorkspacePausedRuntimes } =
    await import("../../agents/sandbox/local-workspace-quiescence.js");
  const filesystemOptions = { signal: store.signal, commitGuard: () => void operations.current() };
  let quiescence: Awaited<ReturnType<typeof quiesceLocalWorkspace>> | undefined;
  const pause = async () => {
    quiescence =
      previous && !options.provision
        ? await timeWorktreePreparationPhase("runtimeQuiesce", () =>
            quiesceLocalWorkspace({
              env: owner.env,
              reason: options.reason,
              workspaceDir: previous.projection_path,
              retained: parseLocalWorkspacePausedRuntimes(
                operations.current().paused_runtimes_json,
              ),
              persist: (runtimes) =>
                operations.rememberPaused(runtimes.length ? JSON.stringify(runtimes) : null),
              assertCurrent: () => void operations.current(),
            }),
          )
        : undefined;
  };
  const capture =
    previous && options.reason === "checkpoint" && options.snapshotCapture
      ? await prepareLocalWorkspaceCheckpointCapture(
          previous.projection_path,
          filesystemOptions,
          () => timeWorktreePreparationPhase("runtimeResume", quiescence!.resume),
          pause,
        )
      : undefined;
  await pause();
  let accepted = false;
  try {
    const result = await run(
      operations,
      quiescence && {
        get retired() {
          return quiescence!.retired;
        },
        retire: () => quiescence!.retire(),
        resume: () => quiescence!.resume(),
      },
      capture,
    );
    accepted = true;
    return result;
  } catch (error) {
    if (error instanceof Error && workspaceSizeRecoveryPaths(error).length > 0) {
      const { describeLocalWorkspaceRecovery } = await import("./local-workspace-recovery.js");
      throw await describeLocalWorkspaceRecovery(error, owner, operations);
    }
    throw error;
  } finally {
    // Retirement finished cleanup before removal could invalidate the old binding.
    // Imports keep the guest frozen until journal settlement. Command exports may
    // already have resumed after capture; their later journal touches canonical files only.
    if (!quiescence?.retired) {
      store.workerAuthority.assertCurrent?.();
    }
    const retained = quiescence?.retired ? undefined : store.get();
    if (
      retained &&
      !retained.journal_json &&
      !(retained.pending_target && isLocalWorkspaceBaseRefreshRef(retained.pending_ref))
    ) {
      if (quiescence) {
        await timeWorktreePreparationPhase("runtimeResume", quiescence.resume);
      }
    }
    if (accepted) {
      options.afterAcceptance?.();
    }
    if (previous && options.reason === "checkpoint") {
      // Command acceptance may release its session owner. This discardable artifact
      // remains under the same reconciliation lease until removal finishes.
      await removeLocalWorkspaceCheckpointCapture(previous.projection_path, {
        signal: store.signal,
        commitGuard: () => void store.get(),
      });
    }
  }
}
