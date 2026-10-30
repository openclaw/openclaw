import fs from "node:fs/promises";
import path from "node:path";
import { FsSafeError } from "@openclaw/fs-safe";
import { tempWorkspace, type TempWorkspaceOptions } from "@openclaw/fs-safe/temp";
import { isMissingPathError } from "../infra/errno.js";

async function describeWritableAncestor(rootDir: string): Promise<string | undefined> {
  let canonicalRoot = path.resolve(rootDir);
  for (;;) {
    try {
      canonicalRoot = await fs.realpath(canonicalRoot);
      break;
    } catch (error) {
      const parent = path.dirname(canonicalRoot);
      if (!isMissingPathError(error) || parent === canonicalRoot) {
        throw error;
      }
      canonicalRoot = parent;
    }
  }
  const ancestry: string[] = [];
  for (let current = canonicalRoot; ; current = path.dirname(current)) {
    ancestry.push(current);
    if (path.dirname(current) === current) {
      break;
    }
  }
  for (const directory of ancestry.toReversed()) {
    const stat = await fs.stat(directory);
    // Diagnostic only: fs-safe remains the authority, including owner and sticky checks.
    if ((stat.mode & 0o022) !== 0 && (stat.mode & 0o1000) === 0) {
      const writable = (stat.mode & 0o002) !== 0 ? "world-writable" : "group-writable";
      const quotedPath = `'${directory.replaceAll("'", "'\\''")}'`;
      return `State directory ${directory} is ${writable} without sticky protection; run chmod go-w ${quotedPath} on the node, then restart the node host.`;
    }
  }
  return undefined;
}

/** Share startup and transfer admission without weakening fs-safe's mutation-time checks. */
export async function createNodeWorkerTempWorkspace(options: TempWorkspaceOptions) {
  try {
    return await tempWorkspace(options);
  } catch (error) {
    if (error instanceof FsSafeError && error.code === "insecure-permissions" && options.rootDir) {
      const message = await describeWritableAncestor(options.rootDir).catch(() => undefined);
      if (message) {
        throw new Error(message, { cause: error });
      }
    }
    throw error;
  }
}
