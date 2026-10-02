import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { hasErrnoCode } from "../infra/errno.js";
import { resolveUserPath } from "../utils.js";
import { WORKSPACE_BOOTSTRAP_FILENAMES } from "./workspace-bootstrap-policy.js";
import {
  resolveCanonicalWorkspacePath,
  WorkspaceAliasRepointedError,
} from "./workspace-state-identity.js";

function statFact(file: string, follow: boolean, content: boolean): string | undefined {
  const stat = follow
    ? fs.statSync(file, { bigint: true, throwIfNoEntry: false })
    : fs.lstatSync(file, { bigint: true, throwIfNoEntry: false });
  if (!stat) {
    return undefined;
  }
  return content
    ? `${stat.dev}:${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`
    : `${stat.dev}:${stat.ino}:${stat.mode}`;
}

/** Request-local filesystem evidence; stored NFC keys never select filesystem paths. */
export function captureWorkspaceStateFilesystemGuard(
  workspaceDir: string,
  content = true,
): () => void {
  const dir = path.resolve(resolveUserPath(workspaceDir));
  const canonical = resolveCanonicalWorkspacePath(dir);
  const root = [statFact(dir, false, false), statFact(dir, true, false)];
  const entries = (directory: string) => {
    try {
      return fs.readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      if (!hasErrnoCode(error, "ENOENT") && !hasErrnoCode(error, "ENOTDIR")) {
        throw error;
      }
      return [];
    }
  };
  const observe = () => {
    const paths: string[] = [];
    if (content) {
      paths.push(
        ...[...WORKSPACE_BOOTSTRAP_FILENAMES, "memory", ".git", "skills"].map((name) =>
          path.join(dir, name),
        ),
      );
      for (const entry of entries(path.join(dir, "skills"))) {
        if (entry.isDirectory()) {
          paths.push(
            path.join(dir, "skills", entry.name),
            path.join(dir, "skills", entry.name, "SKILL.md"),
          );
        }
      }
    }
    return {
      names: content
        ? entries(dir)
            .map((entry) => entry.name)
            .toSorted()
        : [],
      files: paths
        .toSorted()
        .map((file) => [file, statFact(file, false, content), statFact(file, true, content)]),
    };
  };
  const initial = observe();
  return () => {
    const current = resolveCanonicalWorkspacePath(dir);
    if (current !== canonical) {
      throw new WorkspaceAliasRepointedError({
        aliasPath: dir,
        storedWorkspacePath: canonical,
        currentWorkspacePath: current,
      });
    }
    // Concurrent first-time provisioning can create the same empty directory.
    // Existing roots remain pinned; new content still invalidates the observation.
    const currentRoot = [statFact(dir, false, false), statFact(dir, true, false)];
    if (
      (root.some((fact) => fact !== undefined) && !isDeepStrictEqual(root, currentRoot)) ||
      (!root.some((fact) => fact !== undefined) &&
        fs.statSync(dir, { throwIfNoEntry: false })?.isFile()) ||
      !isDeepStrictEqual(observe(), initial)
    ) {
      throw new Error(
        `Workspace filesystem changed while preparing state for ${dir}; retry workspace setup.`,
      );
    }
  };
}
