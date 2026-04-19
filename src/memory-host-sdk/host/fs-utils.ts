import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

export type RegularFileStatResult = { missing: true } | { missing: false; stat: Stats };

export function isFileMissingError(
  err: unknown,
): err is NodeJS.ErrnoException & { code: "ENOENT" } {
  return Boolean(
    err &&
    typeof err === "object" &&
    "code" in err &&
    (err as Partial<NodeJS.ErrnoException>).code === "ENOENT",
  );
}

export async function statRegularFile(absPath: string): Promise<RegularFileStatResult> {
  let stat: Stats;
  try {
    stat = await fs.lstat(absPath);
  } catch (err) {
    if (isFileMissingError(err)) {
      return { missing: true };
    }
    throw err;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error("path required");
  }
  return { missing: false, stat };
}

function isWithinRealRoot(root: string, candidate: string): boolean {
  if (candidate === root) {
    return true;
  }
  const relative = path.relative(root, candidate);
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export async function resolveContainedRegularFile(params: {
  absPath: string;
  allowedRoots: string[];
}): Promise<
  | { missing: true }
  | {
      missing: false;
      stat: Stats;
      realPath: string;
    }
> {
  const statResult = await statRegularFile(params.absPath);
  if (statResult.missing) {
    return { missing: true };
  }
  let realPath: string;
  try {
    realPath = await fs.realpath(params.absPath);
  } catch (err) {
    if (isFileMissingError(err)) {
      return { missing: true };
    }
    throw err;
  }
  const allowedRoots = await Promise.all(
    params.allowedRoots.map(async (root) => {
      try {
        return await fs.realpath(root);
      } catch {
        return path.resolve(root);
      }
    }),
  );
  if (!allowedRoots.some((root) => isWithinRealRoot(root, realPath))) {
    throw new Error("path required");
  }
  return { missing: false, stat: statResult.stat, realPath };
}
