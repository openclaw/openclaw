import fs, { type Dirent } from "node:fs";
import path from "node:path";

// Listed in package.json for the packaging/generator source closure; published installs skip that source-only generation path.

export type DirectoryWalkOptions = {
  /** Maximum entry depth; immediate children have depth 1. Default: 64. */
  maxDepth?: number;
  /** Maximum number of entries, including directories and symlinks. Default: 100,000. */
  maxEntries?: number;
  /** Keep the directory entry but omit its descendants from this inventory. */
  skipDirectory?: (entry: DirectoryWalkEntry) => boolean;
};

export type DirectoryWalkEntry = { relativePath: string; dirent: Dirent };

export class DirectoryWalkLimitError extends Error {
  override name = "DirectoryWalkLimitError";
  readonly code = "ERR_DIRECTORY_WALK_LIMIT";
  readonly limit: "maxDepth" | "maxEntries";
  readonly maximum: number;

  constructor(root: string, limit: "maxDepth" | "maxEntries", maximum: number) {
    super(
      `Directory scan of ${root} exceeded ${limit}=${maximum}; narrow the scan or raise its explicit limit.`,
    );
    this.limit = limit;
    this.maximum = maximum;
  }
}

function createWalk(root: string, options: DirectoryWalkOptions) {
  const maxDepth = options.maxDepth ?? 64;
  const maxEntries = options.maxEntries ?? 100_000;
  for (const [name, value] of Object.entries({ maxDepth, maxEntries })) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(name + " must be a nonnegative safe integer");
    }
  }
  const entries: DirectoryWalkEntry[] = [];
  const pending = [{ relativePath: "", depth: 1 }];
  return {
    entries,
    pending,
    add(dirent: Dirent, parent: { relativePath: string; depth: number }) {
      if (parent.depth > maxDepth) {
        throw new DirectoryWalkLimitError(root, "maxDepth", maxDepth);
      }
      if (entries.length >= maxEntries) {
        throw new DirectoryWalkLimitError(root, "maxEntries", maxEntries);
      }
      const relativePath = path.join(parent.relativePath, dirent.name);
      const entry = { relativePath, dirent };
      entries.push(entry);
      if (dirent.isDirectory() && !options.skipDirectory?.(entry)) {
        pending.push({ relativePath, depth: parent.depth + 1 });
      }
    },
  };
}

function compareEntries(a: DirectoryWalkEntry, b: DirectoryWalkEntry): number {
  return a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0;
}

/**
 * List all descendants in relative-path lexical order, without following symlinks.
 * Symlinks are entries, not directories; a symlink root is rejected. Missing roots
 * throw ENOENT. Limits throw rather than return an incomplete inventory. opendir
 * supplies Dirents (the withFileTypes contract) incrementally, so a single wide
 * directory cannot allocate an unbounded readdir result before the entry limit.
 * This is an inventory, not an authorization boundary against concurrent renames.
 */
export async function listDirectoryTreeStrict(
  root: string,
  options: DirectoryWalkOptions = {},
): Promise<DirectoryWalkEntry[]> {
  const walk = createWalk(root, options);
  if ((await fs.promises.lstat(path.resolve(root))).isSymbolicLink()) {
    throw Object.assign(new Error("Directory scan root must not be a symlink: " + root), {
      code: "ERR_DIRECTORY_WALK_ROOT_SYMLINK",
    });
  }
  for (let parent = walk.pending.pop(); parent; parent = walk.pending.pop()) {
    const directory = await fs.promises.opendir(path.join(root, parent.relativePath));
    for await (const entry of directory) {
      walk.add(entry, parent);
    }
  }
  return walk.entries.toSorted(compareEntries);
}

/** Synchronous counterpart of listDirectoryTreeStrict, for bootstrap and script callers. */
export function listDirectoryTreeStrictSync(
  root: string,
  options: DirectoryWalkOptions = {},
): DirectoryWalkEntry[] {
  const walk = createWalk(root, options);
  if (fs.lstatSync(path.resolve(root)).isSymbolicLink()) {
    throw Object.assign(new Error("Directory scan root must not be a symlink: " + root), {
      code: "ERR_DIRECTORY_WALK_ROOT_SYMLINK",
    });
  }
  for (let parent = walk.pending.pop(); parent; parent = walk.pending.pop()) {
    const directory = fs.opendirSync(path.join(root, parent.relativePath));
    try {
      for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
        walk.add(entry, parent);
      }
    } finally {
      directory.closeSync();
    }
  }
  return walk.entries.toSorted(compareEntries);
}
