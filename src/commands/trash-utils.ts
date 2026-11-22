import fs from "node:fs/promises";
import path from "node:path";
import type { AgentsDeleteResult } from "../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import { formatErrorMessage, isMissingPathError } from "../infra/errors.js";
import { movePathToTrash } from "../infra/fs-safe.js";
import type { RuntimeEnv } from "../runtime.js";
import { shortenHomePath } from "../utils.js";

type AgentDeleteRemovedPath = NonNullable<AgentsDeleteResult["removed"]>[number];
type AgentDeleteFailedPath = NonNullable<AgentsDeleteResult["failed"]>[number];
type MoveToTrashResult = { removed: AgentDeleteRemovedPath } | { failed: AgentDeleteFailedPath };

function trashFailure(pathname: string, error: unknown, runtime: RuntimeEnv): MoveToTrashResult {
  runtime.log(`Failed to move to Trash (manual delete): ${shortenHomePath(pathname)}`);
  return { failed: { path: pathname, reason: formatErrorMessage(error) } };
}

/**
 * Erases the copy fs-safe just moved into Trash. Each move gets its own private
 * `.fs-safe-trash-*` container, so removing that container touches nothing else.
 * Returns false when the copy is kept in Trash.
 */
export async function discardTrashedCopy(trashedPath: string): Promise<boolean> {
  const container = path.dirname(trashedPath);
  if (!path.basename(container).startsWith(".fs-safe-trash-")) {
    return false;
  }
  try {
    await fs.rm(container, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

export async function moveToTrashResult(
  pathname: string,
  runtime: RuntimeEnv,
  assertCurrent?: () => void,
  assertCurrentAsync?: () => Promise<void>,
  options: { permanent?: boolean } = {},
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
    if (assertCurrentAsync) {
      await assertCurrentAsync();
    }
    assertCurrent?.();
    const trashedPath = await movePathToTrash(sourcePath, { allowedRoots });
    if (options.permanent) {
      if (await discardTrashedCopy(trashedPath)) {
        runtime.log(`Deleted: ${shortenHomePath(pathname)}`);
        return { removed: { path: pathname, method: "deleted" } };
      }
      runtime.log(
        `Moved to Trash; permanent deletion failed (empty it manually): ${shortenHomePath(trashedPath)}`,
      );
    } else {
      runtime.log(`Moved to Trash: ${shortenHomePath(pathname)}`);
    }
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
  assertCurrentAsync?: () => Promise<void>,
): Promise<boolean> {
  return (
    "removed" in (await moveToTrashResult(pathname, runtime, assertCurrent, assertCurrentAsync))
  );
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

export async function resolveMoveToTrashSourcePath(targetPath: string): Promise<string> {
  return path.join(await fs.realpath(path.dirname(targetPath)), path.basename(targetPath));
}
