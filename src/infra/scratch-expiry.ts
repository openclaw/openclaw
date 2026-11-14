import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isWorkspaceScratchPath, SCRATCH_EXPIRED_MESSAGE } from "../shared/scratch-expiry.js";
import { hasErrnoCode } from "./errno.js";

export function resolveScratchFilePath(value: string): string | undefined {
  let file = value;
  if (file.startsWith("file:")) {
    try {
      file = fileURLToPath(file);
    } catch {
      return undefined;
    }
  }
  if (!path.isAbsolute(file)) {
    return undefined;
  }
  file = path.normalize(file);
  return isWorkspaceScratchPath(file) ||
    /^node-coverage-[^/\\]+[/\\]/u.test(path.relative(os.tmpdir(), file))
    ? file
    : undefined;
}

export async function isScratchFileExpired(file: string): Promise<boolean> {
  try {
    await fs.lstat(file);
    return false;
  } catch (error) {
    return hasErrnoCode(error, "ENOENT") || hasErrnoCode(error, "ENOTDIR");
  }
}

export class ScratchFileExpiredError extends Error {
  constructor() {
    super(SCRATCH_EXPIRED_MESSAGE);
  }
}
