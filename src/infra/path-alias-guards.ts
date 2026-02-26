import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assertNoHardlinkedFinalPath } from "./hardlink-guards.js";
import { isNotFoundPathError, isPathInside } from "./path-guards.js";

export type PathAliasPolicy = {
  allowFinalSymlinkForUnlink?: boolean;
  allowFinalHardlinkForUnlink?: boolean;
};

export const PATH_ALIAS_POLICIES = {
  strict: Object.freeze({
    allowFinalSymlinkForUnlink: false,
    allowFinalHardlinkForUnlink: false,
  }),
  unlinkTarget: Object.freeze({
    allowFinalSymlinkForUnlink: true,
    allowFinalHardlinkForUnlink: true,
  }),
} as const;

export async function assertNoPathAliasEscape(params: {
  absolutePath: string;
  rootPath: string;
  boundaryLabel: string;
  policy?: PathAliasPolicy;
}): Promise<void> {
  const root = path.resolve(params.rootPath);
  const target = path.resolve(params.absolutePath);
  if (!isPathInside(root, target)) {
    throw new Error(
      `Path escapes ${params.boundaryLabel} (${shortPath(root)}): ${shortPath(params.absolutePath)}`,
    );
  }
  const relative = path.relative(root, target);
  if (relative) {
    const rootReal = await tryRealpath(root);
    const parts = relative.split(path.sep).filter(Boolean);
    let current = root;
    for (let idx = 0; idx < parts.length; idx += 1) {
      current = path.join(current, parts[idx] ?? "");
      const isLast = idx === parts.length - 1;
      try {
        const stat = await fs.lstat(current);
        if (!stat.isSymbolicLink()) {
          continue;
        }
        if (params.policy?.allowFinalSymlinkForUnlink && isLast) {
          return;
        }
        const symlinkTarget = await tryRealpath(current);
        if (!isPathInside(rootReal, symlinkTarget)) {
          throw new Error(
            `Symlink escapes ${params.boundaryLabel} (${shortPath(rootReal)}): ${shortPath(current)}`,
          );
        }
        current = symlinkTarget;
      } catch (error) {
        if (isNotFoundPathError(error)) {
          break;
        }
        throw error;
      }
    }
  }

  await assertNoHardlinkedFinalPath({
    filePath: target,
    root,
    boundaryLabel: params.boundaryLabel,
    allowFinalHardlinkForUnlink: params.policy?.allowFinalHardlinkForUnlink,
  });
}

async function tryRealpath(value: string): Promise<string> {
  try {
    return await fs.realpath(value);
  } catch {
    return path.resolve(value);
  }
}

function shortPath(value: string) {
  if (value.startsWith(os.homedir())) {
    return `~${value.slice(os.homedir().length)}`;
  }
  return value;
}
