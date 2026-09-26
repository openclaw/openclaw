import fs from "node:fs/promises";
import path from "node:path";
import { isMissingPathError } from "../../infra/errors.js";

export function splitNullBuffer(input: Uint8Array): Buffer[] {
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const fields: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < bytes.length; index++) {
    if (bytes[index] !== 0) {
      continue;
    }
    if (index > start) {
      fields.push(bytes.subarray(start, index));
    }
    start = index + 1;
  }
  if (start < bytes.length) {
    fields.push(bytes.subarray(start));
  }
  return fields;
}

/** Emits only nonempty batches using the existing soft count/byte thresholds. */
export function* gitPathspecBatches(paths: readonly string[]): Generator<string[]> {
  let offset = 0;
  while (offset < paths.length) {
    const batch: string[] = [];
    let bytes = 0;
    while (
      offset < paths.length &&
      (batch.length === 0 || (batch.length < 128 && bytes < 16_384))
    ) {
      const entry = paths[offset++]!;
      batch.push(entry);
      bytes += Buffer.byteLength(entry) + 1;
    }
    yield batch;
  }
}

export function gitPathKey(gitPath: Uint8Array): string {
  return Buffer.from(gitPath.buffer, gitPath.byteOffset, gitPath.byteLength).toString("hex");
}

export function checkoutPathFromGitBytes(checkoutRoot: string, gitPath: Buffer): string | Buffer {
  if (process.platform === "win32") {
    return path.join(checkoutRoot, ...gitPath.toString("utf8").split("/"));
  }
  return Buffer.concat([Buffer.from(checkoutRoot), Buffer.from(path.sep), gitPath]);
}

export async function rawPathStat(target: string | Buffer) {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if (isMissingPathError(error)) {
      return undefined;
    }
    throw error;
  }
}

export async function rawPathExists(target: string | Buffer): Promise<boolean> {
  return (await rawPathStat(target)) !== undefined;
}

export type GitTreePath = { path: Buffer; mode: string };
export type GitIndexPath = GitTreePath & { skipWorktree: boolean; assumeUnchanged: boolean };

export function parseGitTreePaths(output: Uint8Array): GitTreePath[] {
  return splitNullBuffer(output).map((entry) => {
    const separator = entry.indexOf(9);
    if (separator < 0) {
      throw new Error("Git tree inventory contains an invalid entry");
    }
    return { path: entry.subarray(separator + 1), mode: entry.subarray(0, 6).toString("ascii") };
  });
}

export function parseGitIndexPaths(output: Uint8Array): GitIndexPath[] {
  return splitNullBuffer(output).map((entry) => {
    const separator = entry.indexOf(9);
    if (separator < 0 || entry[1] !== 32) {
      throw new Error("Git index inventory contains an invalid entry");
    }
    const tag = String.fromCharCode(entry[0] ?? 0);
    return {
      path: entry.subarray(separator + 1),
      mode: entry.subarray(2, 8).toString("ascii"),
      skipWorktree: tag.toUpperCase() === "S",
      // ls-files -v lowercases the tag for assume-unchanged entries.
      assumeUnchanged: tag !== tag.toUpperCase(),
    };
  });
}

/** Read-only batches retain the first observed decision/error in original path order. */
export async function containsGitMarker(
  checkoutRoot: string,
  paths: Iterable<Buffer>,
): Promise<boolean> {
  const checked = new Set<string>();
  const markers: Buffer[] = [];
  for (const gitPath of paths) {
    for (let end = gitPath.indexOf(47); end !== -1; end = gitPath.indexOf(47, end + 1)) {
      const directory = gitPath.subarray(0, end);
      const key = gitPathKey(directory);
      if (!checked.has(key)) {
        checked.add(key);
        markers.push(Buffer.concat([directory, Buffer.from("/.git")]));
      }
    }
  }
  for (let offset = 0; offset < markers.length; offset += 32) {
    const results = await Promise.allSettled(
      markers
        .slice(offset, offset + 32)
        .map((marker) => rawPathExists(checkoutPathFromGitBytes(checkoutRoot, marker))),
    );
    for (const result of results) {
      if (result.status === "rejected") {
        throw result.reason;
      }
      if (result.value) {
        return true;
      }
    }
  }
  return false;
}
