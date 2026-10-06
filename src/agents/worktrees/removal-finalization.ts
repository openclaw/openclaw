import fs from "node:fs/promises";
import path from "node:path";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { formatErrorMessage } from "../../infra/errors.js";
import { hasSqliteWorkerOutcomeUnknown } from "../../infra/sqlite-worker-contract.js";
import type { WorktreeCleanupMutation } from "./gc-removal.js";
import type { requireGit } from "./git.js";
import { finalizeWorktreeRemovalRows, updateRegistryWorktree } from "./registry.js";
import type {
  ManagedWorktreeRecord,
  ManagedWorktreeRunEndCleanup,
  RemoveManagedWorktreeResult,
  WorktreeWorkerAuthority,
} from "./types.js";

type GitOptions = NonNullable<Parameters<typeof requireGit>[2]>;

/** Publish the removed lifecycle and retire its pending ref before releasing checkout custody. */
export async function finalizeManagedWorktreeRemoval(params: {
  record: ManagedWorktreeRecord;
  env: NodeJS.ProcessEnv;
  claimToken: string;
  now: () => number;
  snapshotRef?: string;
  snapshotOid: string;
  snapshotError?: string;
  runEndCleanup?: ManagedWorktreeRunEndCleanup;
  recoveryPath?: string;
  snapshotRetentionMs: number;
  git: typeof requireGit;
  options: GitOptions & { beforeRun: () => void };
  deletionOptions?: GitOptions;
  onFinalized: () => void;
  workerAuthority: WorktreeWorkerAuthority;
  withOwnerMutation?: WorktreeCleanupMutation;
}): Promise<RemoveManagedWorktreeResult> {
  const { record, env, git, options, snapshotRef, snapshotError, recoveryPath } = params;
  options.beforeRun();
  const removedAt = params.now();
  // A failed housekeeping command must not make a deleted checkout appear live.
  const publish = () =>
    updateRegistryWorktree(
      env,
      record.id,
      {
        removedAt,
        snapshotRef,
        ...(params.runEndCleanup ? { runEndCleanup: params.runEndCleanup } : {}),
      },
      {
        assertCurrent: options.beforeRun,
        removalToken: params.claimToken,
        workerAuthority: params.workerAuthority,
      },
    );
  await (params.withOwnerMutation
    ? params.withOwnerMutation(publish, { settle: true })
    : publish());
  params.onFinalized();
  try {
    if (params.deletionOptions) {
      await git(record.repoRoot, ["branch", "-d", "--", record.branch], {
        ...params.deletionOptions,
        ...options,
      });
    }
    // Only prune the recorded checkout's empty parent, never a replacement allocation root.
    options.beforeRun();
    await fs.rmdir(path.dirname(record.path)).catch(() => undefined);
    await git(
      record.repoRoot,
      ["update-ref", "-d", `refs/openclaw/removals/${record.id}`, params.snapshotOid],
      options,
    );
    options.beforeRun();
    await finalizeWorktreeRemovalRows(
      env,
      {
        worktreeId: record.id,
        lastActiveAt: record.lastActiveAt,
        removedAt,
        token: params.claimToken,
      },
      params.workerAuthority,
    );
  } catch (error) {
    if (hasSqliteWorkerOutcomeUnknown(error)) {
      throw error;
    }
    if (params.runEndCleanup) {
      try {
        await updateRegistryWorktree(
          env,
          record.id,
          {
            runEndCleanup: {
              outcome: "failed",
              at: params.now(),
              reason: truncateUtf16Safe(formatErrorMessage(error), 500),
            },
          },
          {
            assertCurrent: options.beforeRun,
            removalToken: params.claimToken,
            workerAuthority: params.workerAuthority,
          },
        );
      } catch (outcomeError) {
        if (hasSqliteWorkerOutcomeUnknown(outcomeError)) {
          throw outcomeError;
        }
        // Preserve the housekeeping failure if its outcome cannot be recorded.
      }
    }
    throw error;
  }
  return {
    removed: true,
    ...(snapshotRef ? { snapshotRef } : {}),
    ...(snapshotError ? { snapshotError } : {}),
    ...(recoveryPath
      ? { recoveryPath, recoveryRetainedUntil: removedAt + params.snapshotRetentionMs }
      : {}),
  };
}
