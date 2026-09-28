// Shared destructive-cleanup planning and guarded removal helpers.
import fs from "node:fs/promises";
import path from "node:path";
import { hasNodeErrorCode, isPathInside } from "@openclaw/fs-safe/path";
import type { AgentsDeleteResult } from "../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import { listAgentIds, resolveAgentWorkspaceDir } from "../agents/agent-scope-config.js";
import { resolveDefaultAgentWorkspaceDir } from "../agents/workspace-default.js";
import {
  prepareLegacyWorkspaceStateReset,
  removeLegacyWorkspaceStateForReset,
} from "../agents/workspace-legacy-state.js";
import {
  deleteWorkspaceState,
  prepareWorkspaceStateDeletion,
} from "../agents/workspace-state-store.js";
import { resolveGatewayLockDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveIdentityPathViaExistingAncestorSync } from "../infra/boundary-path.js";
import { formatErrorMessage, isMissingPathError } from "../infra/errors.js";
import { movePathToTrash } from "../infra/fs-safe.js";
import { acquireGatewayLock, GatewayLockError } from "../infra/gateway-lock.js";
import type { RuntimeEnv } from "../runtime.js";
import { prepareOpenClawStateDatabaseRemoval } from "../state/openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { resolveHomeDir, shortenHomeInString, shortenHomePath } from "../utils.js";

type RemovalResult = {
  ok: boolean;
};

type AgentDeleteRemovedPath = NonNullable<AgentsDeleteResult["removed"]>[number];
type AgentDeleteFailedPath = NonNullable<AgentsDeleteResult["failed"]>[number];
type MoveToTrashResult = { removed: AgentDeleteRemovedPath } | { failed: AgentDeleteFailedPath };

type CleanupResolvedPaths = {
  stateDir: string;
  configPath: string;
  oauthDir: string;
  configInsideState: boolean;
  oauthInsideState: boolean;
};

type RemovalOptions = {
  dryRun?: boolean;
  label?: string;
};

type StateRemovalOptions = {
  dryRun?: boolean;
  preservePaths?: readonly string[];
};

const STATE_CLEANUP_LOCK_TIMEOUT_MS = 250;
const STATE_CLEANUP_LOCK_POLL_INTERVAL_MS = 25;

function trashFailure(pathname: string, error: unknown, runtime: RuntimeEnv): MoveToTrashResult {
  runtime.log(`Failed to move to Trash (manual delete): ${shortenHomePath(pathname)}`);
  return { failed: { path: pathname, reason: formatErrorMessage(error) } };
}

export async function moveToTrashResult(
  pathname: string,
  runtime: RuntimeEnv,
  assertCurrent?: () => void,
): Promise<MoveToTrashResult> {
  if (!pathname) {
    return { failed: { path: pathname, reason: "path is empty" } };
  }
  let isSymbolicLink: boolean;
  try {
    isSymbolicLink = (await fs.lstat(pathname)).isSymbolicLink();
  } catch (error) {
    return isMissingPathError(error)
      ? { removed: { path: pathname, method: "missing" } }
      : trashFailure(pathname, error, runtime);
  }
  try {
    const targetPath = path.resolve(pathname);
    const sourcePath = await resolveMoveToTrashSourcePath(targetPath);
    // fs-safe resolves valid symlinks before allow-root checks; a broken link is handled lexically.
    const allowedRoots = trashAllowedRoots(
      [sourcePath],
      isSymbolicLink ? await fs.realpath(sourcePath).catch(() => undefined) : undefined,
    );
    // Preparation can outlive its owner; revalidate immediately before Trash dispatch.
    assertCurrent?.();
    await movePathToTrash(sourcePath, { allowedRoots });
    runtime.log(`Moved to Trash: ${shortenHomePath(pathname)}`);
    return { removed: { path: pathname, method: "trash" } };
  } catch (error) {
    return trashFailure(pathname, error, runtime);
  }
}

/** Moves a path to Trash when it exists, logging a manual-delete fallback on failure. */
export async function moveToTrash(
  pathname: string,
  runtime: RuntimeEnv,
  assertCurrent?: () => void,
): Promise<boolean> {
  return "removed" in (await moveToTrashResult(pathname, runtime, assertCurrent));
}

/**
 * Allowed Trash roots for OpenClaw-owned paths: each declared path's own parent, plus the
 * resolved parent when the moved path is a symlink (fs-safe checks the link target, and
 * moving a link never touches the directory behind it). fs-safe's default roots (home + tmp)
 * alone refuse every path of a state dir on a volume such as `/data`.
 */
export function trashAllowedRoots(
  declaredPaths: readonly string[],
  resolvedLinkPath?: string,
): string[] {
  const roots = declaredPaths.map((declaredPath) => path.dirname(declaredPath));
  if (resolvedLinkPath !== undefined) {
    roots.push(path.dirname(resolvedLinkPath));
  }
  return [...new Set(roots)];
}

async function resolveMoveToTrashSourcePath(targetPath: string): Promise<string> {
  return path.join(await fs.realpath(path.dirname(targetPath)), path.basename(targetPath));
}

function collectWorkspaceDirs(cfg: OpenClawConfig | undefined): string[] {
  const dirs = new Set<string>();
  if (!cfg) {
    dirs.add(resolveDefaultAgentWorkspaceDir());
    return [...dirs];
  }
  for (const agentId of listAgentIds(cfg)) {
    dirs.add(resolveAgentWorkspaceDir(cfg, agentId));
  }
  return [...dirs];
}

/** Determine which config, credential, and workspace paths cleanup should consider. */
export function buildCleanupPlan(params: {
  cfg: OpenClawConfig | undefined;
  stateDir: string;
  configPath: string;
  oauthDir: string;
}): {
  configInsideState: boolean;
  oauthInsideState: boolean;
  workspaceDirs: string[];
} {
  return {
    configInsideState: isPathInside(params.stateDir, params.configPath),
    oauthInsideState: isPathInside(params.stateDir, params.oauthDir),
    workspaceDirs: collectWorkspaceDirs(params.cfg),
  };
}

function isUnsafeRemovalTarget(target: string): boolean {
  if (!target.trim()) {
    return true;
  }
  const resolved = path.resolve(target);
  const root = path.parse(resolved).root;
  if (resolved === root) {
    return true;
  }
  const home = resolveHomeDir();
  if (home && resolved === path.resolve(home)) {
    return true;
  }
  if (isPathInside(resolved, path.resolve(process.cwd()))) {
    return true;
  }
  return false;
}

/** Remove one path after rejecting empty/root/home targets and honoring dry-run mode. */
export async function removePath(
  target: string,
  runtime: RuntimeEnv,
  opts?: RemovalOptions,
): Promise<RemovalResult> {
  return removePathPreserving(target, [], runtime, opts);
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if (hasNodeErrorCode(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

async function existingPaths(paths: readonly string[]): Promise<string[]> {
  const existing: string[] = [];
  for (const target of paths) {
    if (!target?.trim()) {
      continue;
    }
    const resolved = path.resolve(target);
    try {
      await fs.lstat(resolved);
      existing.push(resolved);
    } catch {
      // Missing workspaces do not need preservation during destructive cleanup.
    }
  }
  return existing;
}

// Service-manager status is advisory; the state lock also covers externally supervised Gateways.
async function acquireStateCleanupOwnership(cleanup: CleanupResolvedPaths) {
  const env = {
    ...process.env,
    OPENCLAW_CONFIG_PATH: cleanup.configPath,
    OPENCLAW_STATE_DIR: cleanup.stateDir,
  };
  let lock: Awaited<ReturnType<typeof acquireGatewayLock>>;
  try {
    lock = await acquireGatewayLock({
      allowInTests: true,
      env,
      pollIntervalMs: STATE_CLEANUP_LOCK_POLL_INTERVAL_MS,
      role: "sqlite-maintenance",
      timeoutMs: STATE_CLEANUP_LOCK_TIMEOUT_MS,
    });
  } catch (error) {
    if (error instanceof GatewayLockError) {
      throw new Error(
        "Cannot remove OpenClaw state while the Gateway or another state maintenance command owns this state directory. Stop the Gateway and retry.",
        { cause: error },
      );
    }
    throw error;
  }
  if (!lock) {
    throw new Error("Cannot remove OpenClaw state without exclusive state ownership.");
  }
  return lock;
}

async function removePathPreserving(
  target: string,
  preservePaths: readonly string[],
  runtime: RuntimeEnv,
  opts?: RemovalOptions,
): Promise<RemovalResult> {
  if (!target?.trim()) {
    return { ok: false };
  }
  const resolved = path.resolve(target);
  const label = opts?.label ?? resolved;
  const displayLabel = shortenHomeInString(label);
  if (isUnsafeRemovalTarget(resolved)) {
    runtime.error(`Refusing to remove unsafe path: ${displayLabel}`);
    return { ok: false };
  }
  if (preservePaths.some((preservePath) => isPathInside(preservePath, resolved))) {
    return { ok: true };
  }
  const nestedPreservedPaths = preservePaths.filter((preservePath) =>
    isPathInside(resolved, preservePath),
  );
  if (opts?.dryRun) {
    const suffix = nestedPreservedPaths.length
      ? ` preserving ${nestedPreservedPaths.map((preservePath) => shortenHomeInString(preservePath)).join(", ")}`
      : "";
    runtime.log(`[dry-run] remove ${displayLabel}${suffix}`);
    return { ok: true };
  }
  try {
    if (nestedPreservedPaths.length > 0 && (await fs.lstat(resolved)).isDirectory()) {
      for (const entry of await fs.readdir(resolved)) {
        const result = await removePathPreserving(
          path.join(resolved, entry),
          preservePaths,
          runtime,
        );
        if (!result.ok) {
          return result;
        }
      }
      runtime.log(`Removed contents of ${displayLabel}`);
    } else {
      await fs.rm(resolved, { recursive: true, force: true });
      runtime.log(`Removed ${displayLabel}`);
    }
    return { ok: true };
  } catch (err) {
    runtime.error(`Failed to remove ${displayLabel}: ${String(err)}`);
    return { ok: false };
  }
}

async function removeStateDirectoryAlias(
  requestedStateDir: string,
  stateDir: string,
  assertCurrent: () => void,
): Promise<void> {
  if (requestedStateDir === stateDir) {
    return;
  }
  try {
    if ((await fs.lstat(requestedStateDir)).isSymbolicLink()) {
      assertCurrent();
      await fs.unlink(requestedStateDir);
    }
  } catch (error) {
    if (!hasNodeErrorCode(error, "ENOENT")) {
      throw error;
    }
  }
}

type CleanupDirectoryIdentity = { path: string; dev: bigint; ino: bigint };

function stateCleanupInterrupted(): Error {
  return new Error(
    "OpenClaw state cleanup was interrupted by a new state operation. Stop other OpenClaw commands and retry.",
  );
}

async function captureStateCleanupAncestors(
  lockDirs: readonly string[],
  stateDir: string,
): Promise<CleanupDirectoryIdentity[]> {
  const directories = new Map<string, CleanupDirectoryIdentity>();
  for (const lockDir of lockDirs) {
    for (let current = lockDir; isPathInside(stateDir, current); current = path.dirname(current)) {
      if (!directories.has(current)) {
        const observed = await fs.lstat(current, { bigint: true });
        if (!observed.isDirectory()) {
          throw new Error(
            `Cannot remove OpenClaw state because its active lock directory is redirected or not a real directory: ${shortenHomeInString(current)}. Restore a real lock directory and retry.`,
          );
        }
        directories.set(current, { path: current, dev: observed.dev, ino: observed.ino });
      }
      if (current === stateDir) {
        break;
      }
    }
  }
  return [...directories.values()].toSorted((left, right) => right.path.length - left.path.length);
}

async function removeEmptyStateAncestors(directories: readonly CleanupDirectoryIdentity[]) {
  for (const expected of directories) {
    try {
      const observed = await fs.lstat(expected.path, { bigint: true });
      if (
        !observed.isDirectory() ||
        observed.dev !== expected.dev ||
        observed.ino !== expected.ino
      ) {
        throw stateCleanupInterrupted();
      }
      await fs.rmdir(expected.path);
    } catch (error) {
      if (hasNodeErrorCode(error, "ENOENT")) {
        continue;
      }
      if (hasNodeErrorCode(error, "ENOTEMPTY") || hasNodeErrorCode(error, "EEXIST")) {
        continue;
      }
      throw error;
    }
  }
}

function linkedCleanupPaths(cleanup: CleanupResolvedPaths): string[] {
  return [
    cleanup.configInsideState ? undefined : cleanup.configPath,
    cleanup.oauthInsideState ? undefined : cleanup.oauthDir,
  ].filter((target): target is string => target !== undefined);
}

async function resolveLinkedCleanupPath(target: string, lockPaths: readonly string[]) {
  if (!(await pathExists(target))) {
    return undefined;
  }
  // Resolve parent aliases, but keep a final symlink lexical: removal only unlinks it.
  const entry = await resolveMoveToTrashSourcePath(path.resolve(target));
  if (lockPaths.some((lockPath) => isPathInside(entry, lockPath))) {
    throw new Error(
      `Cannot remove linked cleanup path ${shortenHomeInString(target)} because it contains an active state lock. Move the linked path outside the lock directory and retry.`,
    );
  }
  return entry;
}

async function removeLinkedCleanupPaths(
  cleanup: CleanupResolvedPaths,
  runtime: RuntimeEnv,
  lockPaths: readonly string[],
  assertCurrent: () => void,
): Promise<void> {
  for (const target of linkedCleanupPaths(cleanup)) {
    const entry = await resolveLinkedCleanupPath(target, lockPaths);
    assertCurrent();
    if (entry && !(await removePath(entry, runtime, { label: target })).ok) {
      throw new Error(`Failed to remove linked cleanup path: ${shortenHomeInString(target)}`);
    }
  }
}

/** Remove state plus config/OAuth paths, preserving selected paths nested inside state. */
export async function removeStateAndLinkedPaths(
  cleanup: CleanupResolvedPaths,
  runtime: RuntimeEnv,
  opts?: StateRemovalOptions,
): Promise<boolean> {
  const requestedStateDir = path.resolve(cleanup.stateDir);
  const requestedPreservePaths = opts?.dryRun
    ? (opts.preservePaths ?? []).map((target) => path.resolve(target))
    : await existingPaths(opts?.preservePaths ?? []);
  if (opts?.dryRun) {
    const preservePaths = requestedPreservePaths.filter((target) =>
      isPathInside(requestedStateDir, target),
    );
    const stateRemoval =
      preservePaths.length > 0
        ? await removePathPreserving(requestedStateDir, preservePaths, runtime, {
            dryRun: true,
            label: cleanup.stateDir,
          })
        : await removePath(cleanup.stateDir, runtime, {
            dryRun: true,
            label: cleanup.stateDir,
          });
    const configRemoval = cleanup.configInsideState
      ? { ok: true }
      : await removePath(cleanup.configPath, runtime, { dryRun: true, label: cleanup.configPath });
    const oauthRemoval = cleanup.oauthInsideState
      ? { ok: true }
      : await removePath(cleanup.oauthDir, runtime, { dryRun: true, label: cleanup.oauthDir });
    return stateRemoval.ok && configRemoval.ok && oauthRemoval.ok;
  }
  if (isUnsafeRemovalTarget(requestedStateDir)) {
    runtime.error(`Refusing to remove unsafe path: ${shortenHomeInString(cleanup.stateDir)}`);
    return false;
  }

  const lock = await acquireStateCleanupOwnership(cleanup);
  let lockHeld = true;
  let removalAdmission: Awaited<ReturnType<typeof prepareOpenClawStateDatabaseRemoval>> | undefined;
  const releaseLock = async () => {
    if (!lockHeld) {
      return;
    }
    lockHeld = false;
    await lock.release();
  };
  const releaseRemovalAdmission = () => {
    const held = removalAdmission;
    removalAdmission = undefined;
    held?.release();
  };
  try {
    const stateDir = lock.stateDir;
    if (isUnsafeRemovalTarget(stateDir)) {
      throw new Error(`Refusing to remove unsafe path: ${shortenHomeInString(stateDir)}`);
    }
    const lockPaths = await Promise.all(
      [...new Set([lock.lockPath, lock.stateLockPath])].map(resolveMoveToTrashSourcePath),
    );
    const lockDirs = [...new Set(lockPaths.map((lockPath) => path.dirname(lockPath)))];
    for (const target of linkedCleanupPaths(cleanup)) {
      await resolveLinkedCleanupPath(target, lockPaths);
    }
    lock.assertCurrent();
    const databasePath = resolveOpenClawStateSqlitePath({
      ...process.env,
      OPENCLAW_STATE_DIR: stateDir,
    });
    if (resolveIdentityPathViaExistingAncestorSync(databasePath) !== databasePath) {
      throw new Error(
        "Cannot remove OpenClaw state because its active database path is redirected. Select the actual state directory before retrying cleanup.",
      );
    }
    // Deleting a lexical link would let startup select a different owner while
    // the canonical lock files are still held. Admit the complete namespace first.
    const directories = await captureStateCleanupAncestors(
      [
        ...lockDirs,
        path.dirname(lock.stateLockPath),
        ...(process.platform === "win32" ? [] : [resolveGatewayLockDir(stateDir)]),
      ],
      stateDir,
    );
    lock.assertCurrent();
    removalAdmission = await lock.run(() =>
      prepareOpenClawStateDatabaseRemoval(databasePath, lock.assertCurrent),
    );
    const preservePaths = requestedPreservePaths
      .map((target) =>
        isPathInside(requestedStateDir, target)
          ? path.join(stateDir, path.relative(requestedStateDir, target))
          : target,
      )
      .filter((target) => isPathInside(stateDir, target));
    const overlappingPreservePath = preservePaths.find((target) =>
      lockDirs.some((lockDir) => isPathInside(lockDir, target) || isPathInside(target, lockDir)),
    );
    if (overlappingPreservePath) {
      throw new Error(
        `Cannot remove OpenClaw state while preserving ${shortenHomeInString(overlappingPreservePath)} because it overlaps the active state lock. Move the workspace outside the lock directory and retry.`,
      );
    }
    removalAdmission.assertCurrent();
    const stateRemoval = await removePathPreserving(
      stateDir,
      [...preservePaths, ...lockPaths],
      runtime,
      { label: cleanup.stateDir },
    );
    if (!stateRemoval.ok) {
      throw new Error("Failed to remove non-preserved OpenClaw state while ownership was held.");
    }

    removalAdmission.assertCurrent();
    await removeLinkedCleanupPaths(cleanup, runtime, lockPaths, lock.assertCurrent);
    if (preservePaths.length === 0) {
      removalAdmission.assertCurrent();
      await removeStateDirectoryAlias(requestedStateDir, stateDir, lock.assertCurrent);
    }

    // A replacement empty directory belongs to the next operation.
    removalAdmission.assertCurrent();
    await releaseLock();
    await removeEmptyStateAncestors(directories);
    const remainingLockPaths = await Promise.all(
      [...lockPaths, ...lockDirs.filter((lockDir) => isPathInside(stateDir, lockDir))].map(
        pathExists,
      ),
    );
    const newStateOperationStarted =
      remainingLockPaths.some(Boolean) ||
      (preservePaths.length === 0 && (await pathExists(stateDir)));
    if (newStateOperationStarted) {
      throw stateCleanupInterrupted();
    }
    return true;
  } finally {
    try {
      releaseRemovalAdmission();
    } finally {
      await releaseLock();
    }
  }
}

/** Remove all workspace directories selected by the cleanup plan. */
export async function removeWorkspaceDirs(
  workspaceDirs: readonly string[],
  runtime: RuntimeEnv,
  opts?: {
    dryRun?: boolean;
    preserveWorkspace?: boolean;
    removeStateRows?: boolean;
    removeWorkspace?: (workspace: string) => Promise<boolean>;
  },
): Promise<string[]> {
  const failures = new Set<string>();
  const attempt = async <T>(label: string, action: () => T | Promise<T>) => {
    try {
      return await action();
    } catch (error) {
      failures.add(label);
      runtime.error?.(`Failed to clean up ${shortenHomeInString(label)}: ${String(error)}`);
      return undefined;
    }
  };
  for (const workspace of workspaceDirs) {
    const legacyLabel = `${workspace} (retired workspace state)`;
    const stateLabel = `${workspace} (workspace state)`;
    const legacyPlan = await attempt(legacyLabel, () =>
      prepareLegacyWorkspaceStateReset(workspace),
    );
    const statePlan = opts?.removeStateRows
      ? await attempt(stateLabel, () => prepareWorkspaceStateDeletion(workspace))
      : undefined;
    const result = opts?.preserveWorkspace
      ? { ok: true }
      : opts?.removeWorkspace
        ? { ok: (await attempt(workspace, () => opts.removeWorkspace!(workspace))) === true }
        : await removePath(workspace, runtime, { dryRun: opts?.dryRun, label: workspace });
    if (!result.ok) {
      failures.add(workspace);
      continue;
    }
    if (legacyPlan) {
      const legacyCleanup = await attempt(legacyLabel, () =>
        removeLegacyWorkspaceStateForReset(legacyPlan, opts?.dryRun ? { dryRun: true } : undefined),
      );
      if (legacyCleanup) {
        if (opts?.dryRun) {
          for (const removedPath of legacyCleanup.removedPaths) {
            runtime.log(`[dry-run] remove ${shortenHomeInString(removedPath)}`);
          }
        }
        for (const warning of legacyCleanup.warnings) {
          (opts?.removeWorkspace ? runtime.log : runtime.error)(warning);
          failures.add(warning);
        }
      }
    }
    if (!opts?.dryRun && statePlan) {
      await attempt(stateLabel, () => deleteWorkspaceState(statePlan));
    }
  }
  return [...failures];
}

/** List per-agent session directories beneath a state directory. */
export async function listAgentSessionDirs(stateDir: string): Promise<string[]> {
  const root = path.join(stateDir, "agents");
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(root, entry.name, "sessions"))
      .toSorted();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}
