import fs from "node:fs/promises";
import path from "node:path";
import { withSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import type { InternalSessionEntry, SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveGatewaySessionStoreTargetInWorker } from "../../gateway/session-utils-store-worker.js";
import { requireGit } from "./git.js";
import type { ManagedWorktreeRecord } from "./types.js";

export const REQUIRED_WORKTREE_UNAVAILABLE =
  "The thread's required workspace is unavailable or changed. Ask a maintainer to restore it, or select a workspace in a new thread.";

/** Compare retained binding facts; callers still own liveness, lineage, and physical custody. */
export function matchesRequiredSessionWorkspace(
  entry: Pick<
    SessionEntry,
    "requiredWorkspace" | "projectId" | "sessionRoot" | "spawnedWorkspaceDir"
  > & { worktree?: { repoRoot?: string; branch?: string } },
  record: { path: string; repoRoot?: string; branch?: string; baseRef?: string },
): boolean {
  return Boolean(
    entry.requiredWorkspace &&
    entry.worktree &&
    entry.projectId === entry.requiredWorkspace.projectId &&
    record.baseRef === entry.requiredWorkspace.worktreeBaseRef &&
    record.repoRoot === entry.worktree.repoRoot &&
    record.branch === entry.worktree.branch &&
    entry.sessionRoot === record.path &&
    entry.spawnedWorkspaceDir === record.path,
  );
}

/** A hidden child borrows custody; it never becomes the registry owner of its parent's checkout. */
export function sharesRequiredSessionWorkspace(child: SessionEntry, parent: SessionEntry): boolean {
  return Boolean(
    child.createdVia === "spawn" &&
    child.parentSessionId === parent.sessionId &&
    child.parentLifecycleRevision !== undefined &&
    child.parentLifecycleRevision === parent.lifecycleRevision &&
    parent.archivedAt === undefined &&
    child.requiredWorkspace &&
    parent.requiredWorkspace &&
    child.requiredWorkspace.projectId === parent.requiredWorkspace.projectId &&
    child.requiredWorkspace.worktreeBaseRef === parent.requiredWorkspace.worktreeBaseRef &&
    child.projectId === parent.projectId &&
    child.worktree?.id === parent.worktree?.id &&
    child.worktree?.branch === parent.worktree?.branch &&
    child.worktree?.repoRoot === parent.worktree?.repoRoot &&
    child.sessionRoot === parent.sessionRoot &&
    child.spawnedCwd === parent.spawnedCwd &&
    child.spawnedWorkspaceDir === parent.spawnedWorkspaceDir,
  );
}

/** Inspect the checkout while the native run lease prevents managed removal. */
export async function assertRequiredSessionWorktreeCheckout(
  record: Pick<ManagedWorktreeRecord, "path" | "repoRoot" | "branch">,
  assertCurrent: () => void,
): Promise<void> {
  assertCurrent();
  const root = await fs.realpath(record.path);
  if (root !== record.path) {
    throw new Error(REQUIRED_WORKTREE_UNAVAILABLE);
  }
  const commonDir = await requireGit(
    record.repoRoot,
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    { beforeRun: assertCurrent },
  );
  const actual = await requireGit(
    root,
    [
      "rev-parse",
      "--path-format=absolute",
      "--show-toplevel",
      "--git-common-dir",
      "--symbolic-full-name",
      "HEAD",
    ],
    { beforeRun: assertCurrent },
  );
  assertCurrent();
  if (actual !== `${root}\n${commonDir}\nrefs/heads/${record.branch}`) {
    throw new Error(REQUIRED_WORKTREE_UNAVAILABLE);
  }
}

/** Validate recorded custody at execution, before a run can acquire its existing native lease. */
export async function assertRequiredSessionWorktree(params: {
  entry: InternalSessionEntry;
  sessionKey?: string;
  cfg?: OpenClawConfig;
  record?: ManagedWorktreeRecord;
  candidatePaths: Array<string | undefined>;
  env?: NodeJS.ProcessEnv;
  assertCurrent?: () => void;
}): Promise<void> {
  const { entry, record, sessionKey } = params;
  if (!entry.requiredWorkspace) {
    return;
  }
  if (
    !sessionKey ||
    !record ||
    !entry.worktree ||
    record.removedAt !== undefined ||
    record.ownerKind !== "session" ||
    record.id !== entry.worktree.id ||
    !matchesRequiredSessionWorkspace(entry, record) ||
    entry.execHost === "node" ||
    entry.execNode ||
    entry.pendingWorktree ||
    entry.pendingProjectGitUrl
  ) {
    throw new Error(REQUIRED_WORKTREE_UNAVAILABLE);
  }
  // Realpath failure is a denial: a missing checkout must never become a new directory.
  const root = await fs.realpath(record.path);
  for (const candidate of [entry.spawnedCwd, ...params.candidatePaths]) {
    if (!candidate) {
      throw new Error(REQUIRED_WORKTREE_UNAVAILABLE);
    }
    const current = await fs.realpath(candidate);
    if (current !== root && !current.startsWith(`${root}${path.sep}`)) {
      throw new Error(REQUIRED_WORKTREE_UNAVAILABLE);
    }
  }
  let currentEntry = entry;
  let currentKey = sessionKey;
  // Config admits at most five nested subagents. Bound corrupt lineage reads too.
  for (let depth = 0; record.ownerId !== currentKey; depth += 1) {
    const parentKey = currentEntry.parentSessionKey;
    if (depth >= 5 || !parentKey || !currentEntry.parentSessionId) {
      throw new Error(REQUIRED_WORKTREE_UNAVAILABLE);
    }
    // Spawn can retain a parent in the default store after its configured store moves.
    const target = await resolveGatewaySessionStoreTargetInWorker({
      cfg: params.cfg ?? {},
      key: parentKey,
      env: params.env,
      assertActive: params.assertCurrent,
    });
    const parent = await withSessionEntryReadOnlyInWorker(
      {
        sessionKey: target.canonicalKey,
        agentId: target.agentId,
        storePath: target.readSource?.path ?? target.storePath,
        env: params.env,
      },
      params.assertCurrent ?? (() => {}),
      async (read) => {
        if (!read.ok) {
          throw read.error;
        }
        return read.value;
      },
    );
    if (!parent || !sharesRequiredSessionWorkspace(currentEntry, parent)) {
      throw new Error(REQUIRED_WORKTREE_UNAVAILABLE);
    }
    currentEntry = parent;
    currentKey = target.canonicalKey;
  }
  params.assertCurrent?.();
}
