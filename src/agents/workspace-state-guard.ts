import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { hasErrnoCode } from "../infra/errno.js";
import { resolveUserPath } from "../utils.js";
import {
  resolveCanonicalWorkspacePath,
  WorkspaceAliasRepointedError,
} from "./workspace-state-identity.js";

function statFact(file: string, follow: boolean): string | undefined {
  const stat = follow
    ? fs.statSync(file, { bigint: true, throwIfNoEntry: false })
    : fs.lstatSync(file, { bigint: true, throwIfNoEntry: false });
  if (!stat) {
    return undefined;
  }
  return `${stat.dev}:${stat.ino}:${stat.mode}`;
}

/** Request-local filesystem evidence; stored NFC keys never select filesystem paths. */
export function captureWorkspaceStateFilesystemGuard(
  workspaceDir: string,
  content = true,
): () => void {
  const dir = path.resolve(resolveUserPath(workspaceDir));
  const canonical = resolveCanonicalWorkspacePath(dir);
  const root = [statFact(dir, false), statFact(dir, true)];
  const names = () => {
    if (!content) {
      return [];
    }
    try {
      return fs.readdirSync(dir).toSorted();
    } catch (error) {
      if (!hasErrnoCode(error, "ENOENT") && !hasErrnoCode(error, "ENOTDIR")) {
        throw error;
      }
      return [];
    }
  };
  const initialNames = names();
  return () => {
    const current = resolveCanonicalWorkspacePath(dir);
    if (current !== canonical) {
      throw new WorkspaceAliasRepointedError({
        aliasPath: dir,
        storedWorkspacePath: canonical,
        currentWorkspacePath: current,
      });
    }
    // Admit first directory creation through an unchanged alias, then pin that
    // inode too. New root entries still invalidate the name observation.
    const currentRoot = [statFact(dir, false), statFact(dir, true)];
    if (
      root.some((fact, index) => fact !== undefined && fact !== currentRoot[index]) ||
      (root[1] === undefined &&
        currentRoot[1] !== undefined &&
        !fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) ||
      !isDeepStrictEqual(names(), initialNames)
    ) {
      throw new Error(
        `Workspace filesystem changed while preparing state for ${dir}; retry workspace setup.`,
      );
    }
    for (let index = 0; index < root.length; index++) {
      root[index] ??= currentRoot[index];
    }
  };
}
