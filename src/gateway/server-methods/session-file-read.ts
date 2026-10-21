import path from "node:path";
import { resolveToCwd } from "../../agents/sessions/tools/path-utils.js";
import { resolveAbsolutePathForRead, root as fsSafeRoot } from "../../infra/fs-safe.js";
import { isPathInside } from "../../infra/path-guards.js";
import { WORKSPACE_PREVIEW_MAX_BYTES } from "../workspace-file-limits.js";
import type { WorkspaceRoot } from "./workspace-fs.js";

export type SessionFileReadBoundary = {
  root?: string;
  fileRoot?: string;
  authorizeHostRead?: () => Promise<boolean>;
};

/** Containment is decided before probing host paths, including paths that do not exist. */
export async function resolveSessionFileReadTarget(
  boundary: SessionFileReadBoundary,
  filePath: string,
): Promise<
  | { root: string | WorkspaceRoot; path: string; absolutePath: string; outside: boolean }
  | "outside_session_boundary"
  | undefined
> {
  if (!boundary.root) {
    return undefined;
  }
  const absolutePath = resolveToCwd(filePath, boundary.fileRoot ?? boundary.root);
  if (isPathInside(boundary.root, absolutePath)) {
    return {
      root: boundary.root,
      path: path.relative(boundary.root, absolutePath),
      absolutePath,
      outside: false,
    };
  }
  if (!(await boundary.authorizeHostRead?.())) {
    return "outside_session_boundary";
  }
  try {
    const { canonicalPath } = await resolveAbsolutePathForRead(absolutePath, {
      symlinks: "follow",
    });
    // A host read uses a local fs-safe handle, never another workspace's remote adapter.
    const root = await fsSafeRoot(path.dirname(canonicalPath), {
      hardlinks: "allow",
      symlinks: "reject",
      nonBlockingRead: true,
      maxBytes: WORKSPACE_PREVIEW_MAX_BYTES,
    });
    return { root, path: path.basename(canonicalPath), absolutePath: canonicalPath, outside: true };
  } catch {
    return undefined;
  }
}
