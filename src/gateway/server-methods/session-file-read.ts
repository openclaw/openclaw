import path from "node:path";
import {
  relativePathInsideSandboxRoot,
  resolveSandboxPathMapping,
} from "../../agents/path-policy.js";
import { resolveToCwd } from "../../agents/sessions/tools/path-utils.js";
import { getAgentWorkspaceAccess } from "../../agents/workspace-access.js";
import { resolveAbsolutePathForRead, root as fsSafeRoot } from "../../infra/fs-safe.js";
import { isPathInside } from "../../infra/path-guards.js";
import type { SessionFileSandboxWorkspace } from "../session-file-workspace.js";
import { sessionMutationForbiddenError } from "../session-mutation-authorization-error.js";
import { WORKSPACE_PREVIEW_MAX_BYTES } from "../workspace-file-limits.js";
import type { WorkspaceRoot } from "./workspace-fs.js";

export type SessionFileReadBoundary = {
  root?: string;
  fileRoot?: string;
  authorizeHostRead?: () => Promise<boolean>;
};

/** Translate a sandbox reference only after its existing allocation proves the same backing. */
export async function prepareSessionFileReadPath(
  params: SessionFileReadBoundary & {
    filePath?: string;
    sandboxWorkspace?: SessionFileSandboxWorkspace;
    worktreeId?: string;
    historical?: boolean;
    assertCurrent: () => void;
    assertReadCurrent: () => void;
  },
): Promise<{ path: string | null | undefined; root?: string; assertCurrent?: () => void }> {
  const sandbox = params.sandboxWorkspace;
  const absolute =
    params.filePath && params.root
      ? resolveToCwd(params.filePath, params.fileRoot ?? params.root)
      : undefined;
  const mapped =
    absolute && params.root && sandbox && !isPathInside(params.root, absolute)
      ? resolveSandboxPathMapping([sandbox], absolute)
      : null;
  const assertCurrent = () => {
    params.assertReadCurrent();
    if (mapped && params.root && getAgentWorkspaceAccess(params.root)) {
      throw sessionMutationForbiddenError("Sandbox file backing is not on this Gateway");
    }
  };
  if (mapped) {
    assertCurrent();
  }
  let runtimeWorkspaceDir: string | undefined = sandbox?.runtimeWorkspaceDir;
  let backingRoot = sandbox?.hostRoot;
  let isWorktreeProjection = false;
  let projectionConflicts: Record<string, unknown> | undefined;
  if (params.worktreeId && params.root && !params.historical) {
    const { checkpointLocalWorkspacePath, withSettledLocalWorkspacePath } =
      await import("../worker-environments/local-workspace-projection.js");
    const { LocalWorkspaceConflictError } =
      await import("../worker-environments/local-workspace-conflict-error.js");
    const request = { cwd: params.root, assertCurrent: params.assertCurrent };
    if (mapped) {
      runtimeWorkspaceDir = await withSettledLocalWorkspacePath(
        { ...request, allowConflict: true },
        async (custody) => {
          if (custody && custody.worktreeId === params.worktreeId) {
            projectionConflicts = custody.conflicts;
            return custody.projectionPath;
          }
          return undefined;
        },
      );
      backingRoot = runtimeWorkspaceDir;
      isWorktreeProjection = Boolean(runtimeWorkspaceDir);
    } else {
      try {
        await checkpointLocalWorkspacePath(request);
      } catch (error) {
        if (!(error instanceof LocalWorkspaceConflictError)) {
          throw error;
        }
      }
    }
    params.assertCurrent();
  }
  if (!mapped || !sandbox || !absolute) {
    return { path: params.filePath };
  }
  let targetReadRoot: string | undefined;
  let targetReadPath = mapped.hostPath;
  const relative = relativePathInsideSandboxRoot(sandbox.containerRoot, absolute);
  const normalizedRelative = relative?.replaceAll("\\", "/");
  const isRetainedConflict =
    isWorktreeProjection &&
    normalizedRelative &&
    projectionConflicts &&
    normalizedRelative in projectionConflicts;
  if (isRetainedConflict && runtimeWorkspaceDir && relative) {
    const separator = sandbox.containerRoot.startsWith("/") ? "/" : "\\";
    targetReadRoot = runtimeWorkspaceDir;
    targetReadPath = path.resolve(targetReadRoot, ...relative.split(separator));
    if (!isPathInside(targetReadRoot, targetReadPath)) {
      return { path: null };
    }
  } else if (
    !params.root ||
    !isPathInside(params.root, mapped.hostPath) ||
    !runtimeWorkspaceDir ||
    !backingRoot
  ) {
    return { path: null };
  }
  if (!backingRoot) {
    return { path: null };
  }
  try {
    const { prepareLocalWorkspaceFileRead } =
      await import("../../agents/sandbox/local-workspace-quiescence.js");
    assertCurrent();
    const assertBackingCurrent = await prepareLocalWorkspaceFileRead({
      workspaceDir: backingRoot,
      runtimeWorkspaceDir,
      containerRoot: sandbox.containerRoot,
      targets: [absolute],
      assertCurrent,
    });
    assertBackingCurrent();
    return {
      path: targetReadPath,
      root: targetReadRoot,
      assertCurrent: assertBackingCurrent,
    };
  } catch {
    params.assertReadCurrent();
    // An unavailable or shadowed alias is never retried as a host filesystem grant.
    return { path: null };
  }
}

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
