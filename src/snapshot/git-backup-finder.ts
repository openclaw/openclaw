import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { executeGitCommandBytes, requireGitCommand as requireGit } from "../infra/git-exec.js";

const FINDER_HEADER_BYTES = 32;
const FINDER_MAX_BYTES = 1024 * 1024;

// DS_Store's versioned Bud1 allocator header identifies the format. Validate
// its duplicated root offset and bounds too; a basename or truncated magic is
// never enough to discard a file from backup history.
function isFinderMetadata(bytes: Buffer, size = bytes.length): boolean {
  if (bytes.length < FINDER_HEADER_BYTES || size > FINDER_MAX_BYTES) {
    return false;
  }
  const offset = bytes.readUInt32BE(8);
  const length = bytes.readUInt32BE(12);
  return (
    bytes.readUInt32BE(0) === 1 &&
    bytes.toString("ascii", 4, 8) === "Bud1" &&
    offset === bytes.readUInt32BE(16) &&
    offset >= FINDER_HEADER_BYTES &&
    length > 0 &&
    offset + 4 + length <= size
  );
}

export async function isFinderMetadataFile(file: string): Promise<boolean> {
  const stat = await fs.lstat(file).catch(() => undefined);
  if (!stat?.isFile() || stat.size > FINDER_MAX_BYTES) {
    return false;
  }
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev) {
      return false;
    }
    const header = Buffer.alloc(FINDER_HEADER_BYTES);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    return bytesRead === header.length && isFinderMetadata(header, opened.size);
  } finally {
    await handle.close();
  }
}

export async function isFinderMetadataBlob(
  repositoryPath: string,
  object: string,
  env?: NodeJS.ProcessEnv,
): Promise<boolean> {
  const size = Number(await requireGit(repositoryPath, ["cat-file", "-s", object], { env }));
  if (!Number.isSafeInteger(size) || size < FINDER_HEADER_BYTES || size > FINDER_MAX_BYTES) {
    return false;
  }
  const result = await executeGitCommandBytes(repositoryPath, ["cat-file", "blob", object], {
    env,
    maxOutputBytes: FINDER_MAX_BYTES,
    terminateOnOutputLimit: true,
  });
  if (result.code !== 0 || result.termination !== "exit" || result.stdoutTruncatedBytes) {
    throw new Error("Unable to read Finder metadata blob for Git backup.");
  }
  return isFinderMetadata(result.stdout);
}

// Scope replacement must not erase ordinary documents with Finder's name.
export async function hasNonFinderNamesake(scopePath: string): Promise<boolean> {
  const directories = [scopePath];
  while (directories.length > 0) {
    const directory = directories.pop()!;
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.name === ".DS_Store") {
        if (!(await isFinderMetadataFile(file))) {
          return true;
        }
      } else if (entry.isDirectory()) {
        // Never follow symlinks while examining an owned scope.
        directories.push(file);
      }
    }
  }
  return false;
}
