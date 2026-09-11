import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { resolvePathViaExistingAncestorSync } from "./boundary-path.js";
import { sha256File } from "./directory-durability.js";
import { hasErrnoCode } from "./errno.js";
import { sameFileMutationFingerprint } from "./file-descriptor.js";
import { root as safeRoot } from "./fs-safe.js";

export async function statOrMissing(pathname: string) {
  try {
    return await fs.lstat(pathname);
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

export async function fileDigest(pathname: string): Promise<{ size: number; sha256: string }> {
  const source = await (
    await safeRoot(path.dirname(pathname))
  ).open(path.basename(pathname), { symlinks: "reject", hardlinks: "reject" });
  try {
    const before = await source.handle.stat({ bigint: true });
    const hashed = await sha256File(source.handle);
    if (!sameFileMutationFingerprint(before, await source.handle.stat({ bigint: true }))) {
      throw new Error(`Update recovery payload changed while reading: ${pathname}`);
    }
    return { size: hashed.bytes, sha256: hashed.digest };
  } finally {
    await source.handle.close();
  }
}

export function canonicalEntryPath(pathname: string): string {
  const absolute = path.resolve(pathname);
  return path.join(
    resolvePathViaExistingAncestorSync(path.dirname(absolute)),
    path.basename(absolute),
  );
}

export const MAX_MANIFEST_BYTES = 128 * 1024 * 1024;

export function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function backupStore(stateDir = resolveStateDir()): string {
  return `${resolvePathViaExistingAncestorSync(stateDir)}.update-captures`;
}

export function captureDirectory(runId: string, stateDir?: string): string {
  return path.join(backupStore(stateDir), runId);
}
