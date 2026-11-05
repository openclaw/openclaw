import fs from "node:fs/promises";
import path from "node:path";
import { isPathInside } from "@openclaw/fs-safe/path";
import type { SessionEntry } from "../config/sessions/types.js";
import { resolveUserPath } from "../utils.js";
import { CronSessionLifecycleClaimError } from "./run-authority.js";

export type CronWorkspaceLease = { release: () => Promise<void> };

/** Retain the persisted conversation's managed checkout through scheduled execution. */
export async function prepareCronSessionWorktree(params: {
  sessionKey: string;
  entry?: SessionEntry;
  workspaceDir: string;
  cwd?: string;
  assertCurrent: () => void;
}): Promise<{ workspaceDir: string; cwd?: string; lease?: CronWorkspaceLease }> {
  const binding = params.entry?.worktree;
  if (!binding) {
    return { workspaceDir: params.workspaceDir, cwd: params.cwd };
  }
  const { captureOpenClawStateWorkerContext } =
    await import("../state/openclaw-state-worker-context.js");
  const { readRegistryWorktree } = await import("../agents/worktrees/registry-read.js");
  const { acquireWorktreeRunLease } = await import("../agents/worktrees/run-lease.js");
  params.assertCurrent();
  const workspaceDir = await fs.realpath(resolveUserPath(params.workspaceDir));
  const cwd = params.cwd ? await fs.realpath(resolveUserPath(params.cwd)) : undefined;
  params.assertCurrent();
  const state = captureOpenClawStateWorkerContext();
  const validateWorktree = async () => {
    const record = await readRegistryWorktree(state, binding.id);
    params.assertCurrent();
    if (
      !record ||
      record.id !== binding.id ||
      record.ownerKind !== "session" ||
      record.ownerId !== params.sessionKey ||
      record.removedAt !== undefined ||
      record.branch !== binding.branch ||
      path.resolve(record.repoRoot) !== path.resolve(binding.repoRoot)
    ) {
      throw new CronSessionLifecycleClaimError(
        params.sessionKey,
        "Bound automation worktree is missing, retired, or mismatched.",
      );
    }
    const root = await fs.realpath(record.path);
    params.assertCurrent();
    if (!isPathInside(root, workspaceDir) || !isPathInside(root, cwd ?? workspaceDir)) {
      throw new CronSessionLifecycleClaimError(
        params.sessionKey,
        "Bound automation workspace does not match its managed worktree.",
      );
    }
  };
  await validateWorktree();
  const lease = await acquireWorktreeRunLease(binding.id);
  try {
    // Admission fences removal; re-read the binding after acquiring its owner-held lease.
    await validateWorktree();
    return { workspaceDir, cwd, lease };
  } catch (error) {
    await lease.release();
    throw error;
  }
}
