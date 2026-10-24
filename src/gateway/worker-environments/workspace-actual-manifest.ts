import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { readFileWindowFully } from "@openclaw/fs-safe/advanced";
import { sha256File } from "../../infra/directory-durability.js";
import {
  FsSafeError,
  isPathInside,
  resolveOpenedFileRealPathForHandle,
  root as fsRoot,
} from "../../infra/fs-safe.js";
import { hasNodeErrorCode } from "../../infra/path-guards.js";
import { createStagedInputPathMatcher } from "../../media/staged-inputs.js";
import { runTasksWithConcurrency } from "../../utils/run-with-concurrency.js";
import { activeWorkspaceHashContext, workspaceStatIdentity } from "./workspace-hash-memo.js";
import {
  MAX_WORKSPACE_INVENTORY_ENTRIES,
  MAX_WORKSPACE_INVENTORY_PATH_BYTES,
  MAX_WORKSPACE_INVENTORY_TOTAL_BYTES,
} from "./workspace-inventory-limits.js";
import {
  gitFileMode,
  serializeWorkerWorkspaceManifest,
  type WorkerWorkspaceManifest,
  type WorkerWorkspaceManifestEntry,
} from "./workspace-manifest.js";
import { isDerivedWorkspacePath, buildCacheInputPaths } from "./workspace-path-exclusions.js";

type WorkspaceFileSnapshot =
  | { type: "file"; mode: number; size: number; sha256: string }
  | { type: "unsupported" };

type WorkspaceFileContents =
  | (Extract<WorkspaceFileSnapshot, { type: "file" }> & { content: Buffer })
  | { type: "unsupported" };

type WorkspaceFileRead = {
  expectedPath: string;
  maxBytes: number | ((openedSize: number) => number);
  root?: string;
  signal?: AbortSignal;
  onIdentity?: (identity: string) => void;
};

function localPath(root: string, relative: string): string {
  return path.join(root, ...relative.split("/"));
}

export function isPortableRootContainedSymlink(
  root: string,
  entryPath: string,
  target: string,
): boolean {
  if (
    !target ||
    target.includes("\\") ||
    path.posix.isAbsolute(target) ||
    path.win32.parse(target).root !== ""
  ) {
    return false;
  }
  const resolved = path.resolve(path.dirname(localPath(root, entryPath)), target);
  return resolved === root || resolved.startsWith(`${root}${path.sep}`);
}

export async function readWorkspaceFileSnapshotWithLimit(
  expectedPath: string,
  maxBytes: number | ((openedSize: number) => number),
  root?: string,
  signal?: AbortSignal,
  onIdentity?: (identity: string) => void,
): Promise<WorkspaceFileSnapshot> {
  return await readWorkspaceFile({
    expectedPath,
    maxBytes,
    root,
    signal,
    contents: false,
    onIdentity,
  });
}

export async function readWorkspaceFileContentsWithLimit(
  expectedPath: string,
  maxBytes: number,
): Promise<WorkspaceFileContents> {
  return await readWorkspaceFile({ expectedPath, maxBytes, contents: true });
}

function readWorkspaceFile(
  params: WorkspaceFileRead & { contents: true },
): Promise<WorkspaceFileContents>;
function readWorkspaceFile(
  params: WorkspaceFileRead & { contents: false },
): Promise<WorkspaceFileSnapshot>;
async function readWorkspaceFile(
  params: WorkspaceFileRead & { contents: boolean },
): Promise<WorkspaceFileSnapshot | WorkspaceFileContents> {
  const { expectedPath, maxBytes, root, signal } = params;
  signal?.throwIfAborted();
  const handle = await fs.open(
    expectedPath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  let buffer: Buffer | undefined;
  try {
    signal?.throwIfAborted();
    const { memo: hashMemo, metrics, owner = "gateway" } = activeWorkspaceHashContext() ?? {};
    const before = await handle.stat({ bigint: true });
    const realPath = await resolveOpenedFileRealPathForHandle(handle, expectedPath);
    if (!before.isFile() || (root && !isPathInside(root, realPath))) {
      throw new Error("Gateway workspace file changed while it was being read");
    }
    // Reserve from the opened descriptor: path metadata can race replacement,
    // and concurrent memo hits must consume the same aggregate byte budget.
    const byteLimit = typeof maxBytes === "number" ? maxBytes : maxBytes(Number(before.size));
    if (before.size > BigInt(byteLimit)) {
      return { type: "unsupported" };
    }
    const identity = workspaceStatIdentity(owner, before);
    let sha256 = params.contents ? undefined : hashMemo?.get(identity);
    let size = Number(before.size);
    if (sha256) {
      if (metrics) {
        metrics.memoHitCount += 1;
      }
    } else {
      if (params.contents) {
        buffer = Buffer.allocUnsafe(Number(before.size) + 1);
        size = await readFileWindowFully(handle, buffer, 0, { signal });
        if (size > byteLimit) {
          return { type: "unsupported" };
        }
        sha256 = createHash("sha256").update(buffer.subarray(0, size)).digest("hex");
      } else {
        try {
          ({ bytes: size, digest: sha256 } = await sha256File(handle, {
            maxBytes: byteLimit,
            signal,
          }));
        } catch (error) {
          signal?.throwIfAborted();
          if (!(error instanceof FsSafeError) || error.code !== "too-large") {
            throw error;
          }
          if (typeof maxBytes !== "number") {
            throw new Error("Gateway workspace file changed while it was being read", {
              cause: error,
            });
          }
          return { type: "unsupported" };
        }
      }
      if (metrics) {
        metrics.contentHashCount += 1;
      }
    }
    const after = await handle.stat({ bigint: true });
    signal?.throwIfAborted();
    if (after.size !== BigInt(size) || workspaceStatIdentity(owner, after) !== identity) {
      throw new Error("Gateway workspace file changed while it was being read");
    }
    hashMemo?.set(identity, sha256);
    params.onIdentity?.(identity);
    const snapshot = {
      type: "file" as const,
      mode: gitFileMode(Number(after.mode & 0o777n)),
      size,
      sha256,
    };
    return params.contents && buffer
      ? { ...snapshot, content: buffer.subarray(0, size) }
      : snapshot;
  } finally {
    await handle.close();
  }
}

type ActualWorkspaceManifestOptions = {
  root: string;
  baseCommit: string | null;
  preserveDirectories?: ReadonlySet<string>;
  includePaths?: ReadonlySet<string>;
  buildCacheInputs?: ReadonlySet<string>;
  signal?: AbortSignal;
};

type ActualWorkspaceNode = WorkerWorkspaceManifestEntry | { path: string; type: "directory" };

export async function scanActualWorkspaceManifest(
  params: ActualWorkspaceManifestOptions & {
    onEntry: (entry: ActualWorkspaceNode, identity?: string) => void;
    reuseFile?: (
      entryPath: string,
      identity: string,
    ) => Extract<WorkerWorkspaceManifestEntry, { type: "file" }> | undefined;
  },
): Promise<void> {
  params.signal?.throwIfAborted();
  let root: string;
  let isStagedInput: ReturnType<typeof createStagedInputPathMatcher>;
  try {
    root = await fs.realpath(params.root);
    isStagedInput = createStagedInputPathMatcher(await fsRoot(root));
  } catch (error) {
    params.signal?.throwIfAborted();
    throw error;
  }
  const retained = buildCacheInputPaths(params.buildCacheInputs);
  let entryCount = 0;
  let totalBytes = 0;
  let manifestPathBytes = 0;
  let traversedEntries = 0;
  let traversedPathBytes = 0;
  const addBytes = (bytes: number): void => {
    totalBytes += bytes;
    if (totalBytes > MAX_WORKSPACE_INVENTORY_TOTAL_BYTES) {
      throw new Error("Gateway workspace manifest exceeds its eligible byte limit");
    }
  };
  const addEntry = (entry: ActualWorkspaceNode, bytes = 0, identity?: string): void => {
    addBytes(bytes);
    manifestPathBytes += Buffer.byteLength(entry.path);
    if (manifestPathBytes > MAX_WORKSPACE_INVENTORY_PATH_BYTES) {
      throw new Error("Gateway workspace manifest paths exceed their byte limit");
    }
    entryCount += 1;
    if (entryCount > MAX_WORKSPACE_INVENTORY_ENTRIES) {
      throw new Error("Gateway workspace manifest has too many entries");
    }
    params.onEntry(entry, identity);
  };
  const scanController = new AbortController();
  const scanSignal = params.signal
    ? AbortSignal.any([params.signal, scanController.signal])
    : scanController.signal;
  const checkTraversal = (relative: string): void => {
    scanSignal.throwIfAborted();
    traversedEntries += 1;
    traversedPathBytes += Buffer.byteLength(relative);
    if (traversedEntries > MAX_WORKSPACE_INVENTORY_ENTRIES) {
      throw new Error("Gateway workspace manifest has too many entries");
    }
    if (traversedPathBytes > MAX_WORKSPACE_INVENTORY_PATH_BYTES) {
      throw new Error("Gateway workspace manifest paths exceed their byte limit");
    }
  };
  const filePaths: string[] = [];
  const hashContext = activeWorkspaceHashContext();
  const runScans = async (
    start: number,
    end: number,
    scan: (index: number) => Promise<void>,
  ): Promise<void> => {
    let next = start;
    let taskFailureWasFirst = false;
    const result = await runTasksWithConcurrency({
      // Keep the queued graph bounded too: each worker claims an index before
      // awaiting I/O, rather than retaining one task per inventory entry.
      tasks: Array.from({ length: Math.min(4, end - start) }, () => async () => {
        while (next < end && !scanSignal.aborted) {
          await scan(next++);
        }
      }),
      limit: 4,
      errorMode: "stop",
      onTaskError: (error) => {
        // Composite signals can resolve reasons lazily; record ordering at the owner.
        if (!scanController.signal.aborted) {
          taskFailureWasFirst = !params.signal?.aborted;
        }
        scanController.abort(error);
      },
    });
    if (result.hasError) {
      if (!taskFailureWasFirst) {
        params.signal?.throwIfAborted();
      }
      throw result.firstError;
    }
    scanSignal.throwIfAborted();
  };
  const addFile = async (relative: string): Promise<void> => {
    let identity: string | undefined;
    const snapshot = await readWorkspaceFileSnapshotWithLimit(
      localPath(root, relative),
      (size) => {
        addBytes(size);
        return size;
      },
      root,
      scanSignal,
      (value) => {
        identity = value;
      },
    );
    if (snapshot.type === "file") {
      addEntry({ path: relative, ...snapshot }, 0, identity);
      return;
    }
    throw new Error("Gateway workspace manifest exceeds its eligible byte limit");
  };
  const addLeaf = async (
    relative: string,
    absolute: string,
    stats: BigIntStats,
  ): Promise<boolean> => {
    if (stats.isSymbolicLink()) {
      const target = await fs.readlink(absolute);
      if (!isPortableRootContainedSymlink(root, relative, target)) {
        return false;
      }
      addEntry({ path: relative, type: "symlink", mode: 0o777, target }, Buffer.byteLength(target));
    } else if (stats.isFile()) {
      const identity = workspaceStatIdentity(hashContext?.owner ?? "gateway", stats);
      const reusable = params.reuseFile?.(relative, identity);
      const sha256 = reusable?.sha256 ?? hashContext?.memo.get(identity);
      if (sha256) {
        // Included paths can cross a replaced parent directory even when the
        // leaf inode still matches a prior content hash.
        if ((await fs.realpath(absolute)) !== absolute) {
          throw new Error("Gateway workspace file changed while it was being read");
        }
        addEntry(
          reusable ?? {
            path: relative,
            type: "file",
            mode: gitFileMode(Number(stats.mode & 0o777n)),
            size: Number(stats.size),
            sha256,
          },
          Number(stats.size),
          identity,
        );
        if (hashContext?.metrics) {
          hashContext.metrics.memoHitCount += 1;
        }
      } else {
        filePaths.push(relative);
      }
    } else {
      return false;
    }
    return true;
  };
  const addIncludedPath = async (
    relative: string,
    includedParents: ReadonlySet<string>,
    derivedOnlyDirectories: ReadonlySet<string>,
  ): Promise<"included" | "derived-only" | "absent"> => {
    if (
      isDerivedWorkspacePath(
        relative,
        retained.has(relative) || (await isStagedInput(relative)),
        params.buildCacheInputs !== undefined,
      )
    ) {
      return "derived-only";
    }
    checkTraversal(relative);
    const absolute = localPath(root, relative);
    const stats = await fs.lstat(absolute, { bigint: true }).catch((error: unknown) => {
      if (hasNodeErrorCode(error, "ENOENT") || hasNodeErrorCode(error, "ENOTDIR")) {
        return undefined;
      }
      throw error;
    });
    if (!stats) {
      return "absent";
    }
    if (stats.isDirectory() && !stats.isSymbolicLink()) {
      if (params.preserveDirectories?.has(relative) || includedParents.has(relative)) {
        addEntry({ path: relative, type: "directory" });
        return "included";
      }
      for await (const entry of await fs.opendir(absolute)) {
        scanSignal.throwIfAborted();
        const child = `${relative}/${entry.name}`;
        if (
          isDerivedWorkspacePath(
            child,
            retained.has(child) || (await isStagedInput(child)),
            params.buildCacheInputs !== undefined,
          ) ||
          derivedOnlyDirectories.has(child)
        ) {
          return "derived-only";
        }
      }
      addEntry({ path: relative, type: "directory" });
      return "included";
    }
    return (await addLeaf(relative, absolute, stats)) ? "included" : "absent";
  };
  const walk = async (
    relativeDirectory: string,
  ): Promise<{ hasDerivedEntry: boolean; included: boolean }> => {
    const absoluteDirectory = relativeDirectory ? localPath(root, relativeDirectory) : root;
    let hasDerivedEntry = false;
    let hasNonDerivedEntry = false;
    for await (const directoryEntry of await fs.opendir(absoluteDirectory)) {
      const name = directoryEntry.name;
      const relative = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      checkTraversal(relative);
      if (!relativeDirectory && name === ".git") {
        continue;
      }
      if (
        isDerivedWorkspacePath(
          relative,
          retained.has(relative) || (await isStagedInput(relative)),
          params.buildCacheInputs !== undefined,
        )
      ) {
        hasDerivedEntry = true;
        continue;
      }
      const absolute = localPath(root, relative);
      const stats = await fs.lstat(absolute, { bigint: true });
      if (stats.isDirectory() && !stats.isSymbolicLink()) {
        const child = await walk(relative);
        if (child.included || params.preserveDirectories?.has(relative)) {
          addEntry({ path: relative, type: "directory" });
          hasNonDerivedEntry = true;
        } else {
          hasDerivedEntry ||= child.hasDerivedEntry;
        }
      } else {
        // Unsupported nodes and escaping links still make their directory nonempty;
        // they stay local and become conflicts if a worker changes the same path.
        hasNonDerivedEntry = true;
        await addLeaf(relative, absolute, stats);
      }
    }
    return {
      hasDerivedEntry,
      // Preserve real empty directories, but omit a directory whose only
      // physical contents are excluded derived paths.
      included: hasNonDerivedEntry || !hasDerivedEntry,
    };
  };
  if (params.includePaths) {
    const includedParents = new Set<string>();
    const derivedOnlyDirectories = new Set<string>();
    const paths = [...params.includePaths]
      .map((relative) => ({ relative, depth: relative.split("/").length }))
      .toSorted(
        (left, right) => right.depth - left.depth || left.relative.localeCompare(right.relative),
      );
    // Siblings are independent, but parent classification needs every deeper
    // membership result. Join each depth before admitting the next one.
    for (let start = 0; start < paths.length;) {
      let end = start + 1;
      while (end < paths.length && paths[end]!.depth === paths[start]!.depth) {
        end++;
      }
      await runScans(start, end, async (index) => {
        const { relative } = paths[index]!;
        const state = await addIncludedPath(relative, includedParents, derivedOnlyDirectories);
        if (state === "included") {
          includedParents.add(path.posix.dirname(relative));
        } else if (state === "derived-only") {
          derivedOnlyDirectories.add(relative);
        }
      });
      start = end;
    }
  } else {
    await runScans(0, 1, async () => {
      await walk("");
    });
  }
  // No file readers overlap metadata selection; failures stop new admission
  // and join all opened handles before any manifest can be returned.
  await runScans(0, filePaths.length, (index) => addFile(filePaths[index]!));
  scanSignal.throwIfAborted();
}

export async function readActualWorkspaceManifestImpl(
  params: ActualWorkspaceManifestOptions,
): Promise<{ manifest: WorkerWorkspaceManifest; manifestRef: string; rawManifest: string }> {
  const entries: WorkerWorkspaceManifestEntry[] = [];
  const directories: string[] = [];
  await scanActualWorkspaceManifest({
    ...params,
    onEntry(entry) {
      if (entry.type === "directory") {
        directories.push(entry.path);
      } else {
        entries.push(entry);
      }
    },
  });
  const manifest: WorkerWorkspaceManifest = {
    version: 1,
    baseCommit: params.baseCommit,
    ...(params.buildCacheInputs !== undefined
      ? { buildCacheInputs: [...buildCacheInputPaths(params.buildCacheInputs)] }
      : {}),
    entries: entries.toSorted((left, right) => left.path.localeCompare(right.path)),
    directories: directories.toSorted((left, right) => left.localeCompare(right)),
  };
  const raw = serializeWorkerWorkspaceManifest(manifest);
  const manifestRef = `sha256:${createHash("sha256").update(raw).digest("hex")}`;
  return {
    manifestRef,
    manifest,
    rawManifest: raw,
  };
}
