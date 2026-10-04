import type { SkillSnapshot } from "../types.js";

const EXECUTION_WORKSPACE_FILE_HOST = "executionWorkspaceFileHost";

type SkillRoots = NonNullable<SkillSnapshot["skillRoots"]>;

export function recordSkillRootsExecutionFileHost<T extends SkillRoots>(
  roots: T,
  host: "gateway" | undefined,
): T {
  if (host === undefined) {
    Reflect.deleteProperty(roots, EXECUTION_WORKSPACE_FILE_HOST);
  } else {
    Reflect.set(roots, EXECUTION_WORKSPACE_FILE_HOST, host);
  }
  return roots;
}

export function resolveSkillSnapshotExecutionFileHost(
  snapshot: SkillSnapshot | undefined,
): "gateway" | undefined {
  const roots = snapshot?.skillRoots;
  if (!roots) {
    return undefined;
  }
  return Reflect.get(roots, EXECUTION_WORKSPACE_FILE_HOST) === "gateway" ? "gateway" : undefined;
}

export function copySkillSnapshotExecutionFileHost<T extends SkillSnapshot>(
  source: SkillSnapshot,
  target: T,
): T {
  if (target.skillRoots) {
    recordSkillRootsExecutionFileHost(
      target.skillRoots,
      resolveSkillSnapshotExecutionFileHost(source),
    );
  }
  return target;
}
