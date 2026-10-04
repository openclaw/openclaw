import { existsSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import type { PreservedSessionWorktree } from "../../packages/gateway-protocol/src/index.js";
import { SessionWorktreeLifecycleError } from "../agents/worktrees/errors.js";
import { runGit } from "../agents/worktrees/git.js";
import { getRegistryWorktree } from "../agents/worktrees/registry.js";
import {
  classifyWorktreeRemovalError,
  managedWorktrees,
  ManagedWorktreeService,
} from "../agents/worktrees/service.js";
import type { ManagedWorktreeRecord, WorktreeWorkerAuthority } from "../agents/worktrees/types.js";
import { loadSessionEntry, type SessionAccessScope } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { getChildLogger } from "../logging/logger.js";

function serviceFor(env?: NodeJS.ProcessEnv) {
  return env ? new ManagedWorktreeService({ env }) : managedWorktrees;
}

function belongsToSession(record: ManagedWorktreeRecord, sessionKey: string) {
  return record.ownerKind === "session" && record.ownerId === sessionKey;
}

/** The session lifecycle fence remains held until this exact bound checkout finishes cleanup. */
export async function removeSessionWorktree(params: {
  id?: string;
  sessionKey: string;
  reason: string;
  commitGuard?: () => void;
  workerAuthority?: WorktreeWorkerAuthority;
  env?: NodeJS.ProcessEnv;
}): Promise<PreservedSessionWorktree | undefined> {
  if (!params.id) {
    return undefined;
  }
  const env = params.env ?? process.env;
  const record = getRegistryWorktree(env, params.id);
  if (!record || record.removedAt !== undefined) {
    return undefined;
  }
  const assertCurrent = () => {
    params.commitGuard?.();
    const current = getRegistryWorktree(env, record.id);
    if (current && !belongsToSession(current, params.sessionKey)) {
      throw new SessionWorktreeLifecycleError(
        "Session worktree ownership changed; retry cleanup.",
        "owner-mismatch",
      );
    }
  };
  try {
    assertCurrent();
    await serviceFor(params.env).remove({
      id: record.id,
      reason: params.reason,
      commitGuard: assertCurrent,
      workerAuthority: {
        ...params.workerAuthority,
        assertCurrent: params.workerAuthority
          ? params.workerAuthority.assertCurrent
          : params.commitGuard,
        predicates: [
          ...(params.workerAuthority?.predicates ?? []),
          { kind: "session-owner", id: record.id, sessionKey: params.sessionKey },
        ],
      },
    });
  } catch (error) {
    // Authorization loss is a failed lifecycle action, not successful best-effort cleanup.
    params.commitGuard?.();
    const current = getRegistryWorktree(env, record.id);
    if (current && current.removedAt === undefined) {
      const reason =
        error instanceof SessionWorktreeLifecycleError && error.reason === "owner-mismatch"
          ? error.reason
          : classifyWorktreeRemovalError(error);
      getChildLogger({ subsystem: "session-worktree" }).warn("Session worktree preserved", {
        worktreeId: record.id,
        sessionKey: params.sessionKey,
        reason,
      });
      return { id: current.id, branch: current.branch, path: current.path, reason };
    }
  }
  return undefined;
}

/** Restore preparation preserves conversation metadata until its caller commits unarchive. */
export async function restoreSessionWorktree(params: {
  entry: SessionEntry;
  scope: SessionAccessScope;
  commitGuard?: () => void;
  assertRestoreAllowed?: () => void;
}): Promise<() => void> {
  const { entry, scope } = params;
  const id = entry.worktree?.id;
  if (!id) {
    return () => params.commitGuard?.();
  }
  const assertSessionCurrent = () => {
    params.commitGuard?.();
    const current = loadSessionEntry(scope);
    if (
      current?.sessionId !== entry.sessionId ||
      current?.lifecycleRevision !== entry.lifecycleRevision ||
      current?.archivedAt !== entry.archivedAt ||
      !isDeepStrictEqual(current?.worktree, entry.worktree)
    ) {
      throw new SessionWorktreeLifecycleError(
        "Session changed while preparing its worktree; retry the request.",
        "session-changed",
      );
    }
  };
  const assertCurrent = () => {
    assertSessionCurrent();
    const record = getRegistryWorktree(scope.env ?? process.env, id);
    if (record && !belongsToSession(record, scope.sessionKey)) {
      throw new SessionWorktreeLifecycleError(
        "Session worktree has a different owner; restore the correct binding before retrying.",
        "owner-mismatch",
      );
    }
  };
  const workerAuthority: WorktreeWorkerAuthority = {
    assertCurrent: assertSessionCurrent,
    predicates: [{ kind: "session-owner", id, sessionKey: scope.sessionKey }],
  };
  assertCurrent();
  const record = getRegistryWorktree(scope.env ?? process.env, id);
  if (!record || (record.removedAt !== undefined && !record.snapshotRef)) {
    throw new SessionWorktreeLifecycleError(
      "Session worktree snapshot is missing or expired. The conversation is preserved; start a new worktree task from the source repository to continue.",
      "restore-failed",
    );
  }
  if (record.removedAt !== undefined) {
    params.assertRestoreAllowed?.();
    try {
      await serviceFor(scope.env).restore({ id, commitGuard: assertCurrent, workerAuthority });
    } catch (error) {
      assertCurrent();
      if (error instanceof SessionWorktreeLifecycleError) {
        throw error;
      }
      if (!existsSync(record.repoRoot)) {
        throw new SessionWorktreeLifecycleError(
          "Session worktree source repository is missing. Restore the original repository and its snapshot refs, then retry; otherwise start a new worktree task. The conversation is preserved.",
          "restore-failed",
        );
      }
      const snapshot = await runGit(record.repoRoot, [
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${record.snapshotRef}^{commit}`,
      ]);
      assertCurrent();
      if (snapshot.code !== 0) {
        throw new SessionWorktreeLifecycleError(
          "Session worktree snapshot is missing or unavailable. Restore the original repository snapshot, or start a new worktree task. The conversation is preserved.",
          "restore-failed",
        );
      }
      throw new SessionWorktreeLifecycleError(
        "Session worktree could not be restored. Free disk space if needed, check the source repository, then retry. The conversation and snapshot are preserved.",
        "restore-failed",
      );
    }
  }
  assertCurrent();
  return assertCurrent;
}
