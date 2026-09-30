// Shared workspace filesystem access for gateway file browsers and editors.
// Local access uses fs-safe roots; remote access stays with the registered
// workspace provider and its path/byte/lifecycle checks.
import { createHash } from "node:crypto";
import path from "node:path";
import { createAsyncLock, readFileWindowFully } from "@openclaw/fs-safe/advanced";
import { extractErrorCode } from "@openclaw/normalization-core/error-coercion";
import {
  getAgentWorkspaceAccess,
  type AgentWorkspaceAccess,
} from "../../agents/workspace-access.js";
import { root as fsSafeRoot, FsSafeError, type ReadResult } from "../../infra/fs-safe.js";
import { isPathInside } from "../../infra/path-guards.js";
import { WORKSPACE_PREVIEW_MAX_BYTES } from "../workspace-file-limits.js";

type LocalWorkspaceRoot = Awaited<ReturnType<typeof fsSafeRoot>>;
export type WorkspaceRoot =
  | LocalWorkspaceRoot
  | {
      rootReal: string;
      access: AgentWorkspaceAccess;
    };
type WorkspacePathStat = Pick<
  Awaited<ReturnType<LocalWorkspaceRoot["stat"]>>,
  "isFile" | "isDirectory" | "size" | "mtimeMs"
>;
export type WorkspaceDirEntry = WorkspacePathStat & { name: string };
type WorkspaceFileReadResult = {
  buffer: Buffer;
  stat: { size: number; mtimeMs: number };
  canonicalPath: string;
  readOnly?: boolean;
};

export const enqueueWorkspaceFileUpdate = createAsyncLock();

export async function openWorkspaceRoot(rootDir: string): Promise<WorkspaceRoot | undefined> {
  // Resolve the owner before trying local storage. A stopped remote binding must
  // remain unavailable rather than exposing a Gateway-side copy.
  const access = getAgentWorkspaceAccess(rootDir);
  if (access) {
    return { rootReal: path.resolve(rootDir), access };
  }
  try {
    return await fsSafeRoot(rootDir, {
      hardlinks: "reject",
      maxBytes: WORKSPACE_PREVIEW_MAX_BYTES,
      nonBlockingRead: true,
      symlinks: "reject",
    });
  } catch {
    return undefined;
  }
}

function remoteFilePath(root: WorkspaceRoot, browserPath: string): string {
  const resolved = resolveWorkspacePath(root.rootReal, browserPath || ".");
  if (!resolved) {
    throw new Error("Path escapes the workspace");
  }
  return resolved;
}

export async function statWorkspacePath(
  rootDir: string | WorkspaceRoot,
  browserPath: string,
  assertCurrent?: () => void,
): Promise<WorkspacePathStat | undefined> {
  const workspaceRoot = typeof rootDir === "string" ? await openWorkspaceRoot(rootDir) : rootDir;
  if (!workspaceRoot) {
    return undefined;
  }
  assertCurrent?.();
  if ("access" in workspaceRoot) {
    const stat = await workspaceRoot.access.bridge.stat({
      filePath: remoteFilePath(workspaceRoot, browserPath),
    });
    return stat
      ? {
          isFile: stat.type === "file",
          isDirectory: stat.type === "directory",
          size: stat.size,
          mtimeMs: stat.mtimeMs,
        }
      : undefined;
  }
  try {
    return await workspaceRoot.stat(browserPath || ".");
  } catch {
    return undefined;
  }
}

export async function listWorkspacePath(
  rootDir: string | WorkspaceRoot,
  browserPath: string,
  assertCurrent?: () => void,
): Promise<WorkspaceDirEntry[] | undefined> {
  const workspaceRoot = typeof rootDir === "string" ? await openWorkspaceRoot(rootDir) : rootDir;
  if (!workspaceRoot) {
    return undefined;
  }
  assertCurrent?.();
  if ("access" in workspaceRoot) {
    const list = workspaceRoot.access.bridge.readDirectory;
    if (!list) {
      throw new Error("Workspace host does not support directory browsing");
    }
    const filePath = remoteFilePath(workspaceRoot, browserPath);
    const entries = await list({ filePath });
    const result: WorkspaceDirEntry[] = [];
    for (const entry of entries) {
      // Use listing metadata when supplied. Re-statting every child adds a
      // network round trip per entry; old nodes also reject symlink stats.
      let stat: WorkspacePathStat | undefined;
      if (entry.isFile !== undefined && entry.size !== undefined && entry.mtimeMs !== undefined) {
        stat = {
          isFile: entry.isFile,
          isDirectory: entry.isDirectory,
          size: entry.size,
          mtimeMs: entry.mtimeMs,
        };
      } else {
        try {
          stat = await statWorkspacePath(
            workspaceRoot,
            path.join(browserPath, entry.name),
            assertCurrent,
          );
        } catch (error) {
          const code = extractErrorCode(error);
          if (code === "SYMLINK_REDIRECT" || code === "UNSUPPORTED_FILE_TYPE") {
            continue;
          }
          throw error;
        }
      }
      if (stat) {
        result.push({ ...stat, name: entry.name });
      }
    }
    return result;
  }
  try {
    return await workspaceRoot.list(browserPath || ".", { withFileTypes: true });
  } catch (error) {
    if (error instanceof FsSafeError && error.code === "invalid-path") {
      throw new FsSafeError(
        "invalid-path",
        `Cannot list workspace directory ${JSON.stringify(browserPath || ".")}: ${error.message}`,
        { cause: error },
      );
    }
    return undefined;
  }
}

export async function readWorkspaceFile(
  rootDir: string,
  browserPath: string,
  opts?: { maxBytes?: number; assertCurrent?: () => void },
): Promise<WorkspaceFileReadResult | undefined | "too-large"> {
  const workspaceRoot = await openWorkspaceRoot(rootDir);
  if (!workspaceRoot) {
    return undefined;
  }
  opts?.assertCurrent?.();
  if ("access" in workspaceRoot) {
    const filePath = remoteFilePath(workspaceRoot, browserPath);
    const stat = await workspaceRoot.access.bridge.stat({ filePath });
    if (!stat || stat.type !== "file") {
      return undefined;
    }
    const maxBytes = opts?.maxBytes ?? WORKSPACE_PREVIEW_MAX_BYTES;
    if (stat.size > maxBytes) {
      return "too-large";
    }
    opts?.assertCurrent?.();
    let buffer: Buffer;
    try {
      buffer = await workspaceRoot.access.bridge.readFile({ filePath, maxBytes });
    } catch (error) {
      if (extractErrorCode(error) === "FILE_TOO_LARGE") {
        return "too-large";
      }
      throw error;
    }
    if (buffer.length > maxBytes) {
      return "too-large";
    }
    return {
      buffer,
      stat: { size: buffer.length, mtimeMs: stat.mtimeMs },
      canonicalPath: path.relative(workspaceRoot.rootReal, filePath).split(path.sep).join("/"),
      // The existing remote bridge does not provide an atomic old-content CAS.
      readOnly: true,
    };
  }
  try {
    const read = await workspaceRoot.read(browserPath, { maxBytes: opts?.maxBytes });
    return {
      ...read,
      canonicalPath: path.relative(workspaceRoot.rootReal, read.realPath).split(path.sep).join("/"),
    };
  } catch (err) {
    if (err instanceof FsSafeError && err.code === "too-large") {
      return "too-large";
    }
    return undefined;
  }
}

/** Reads only a bounded prefix after fs-safe opens and verifies the file identity. */
export async function readWorkspaceFilePrefix(
  rootDir: string,
  browserPath: string,
  maxBytes: number,
): Promise<WorkspaceFileReadResult | undefined | "unsupported"> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    return undefined;
  }
  const workspaceRoot = await openWorkspaceRoot(rootDir);
  if (!workspaceRoot) {
    return undefined;
  }
  if ("access" in workspaceRoot) {
    // Do not download an oversized remote file just to sniff its prefix.
    return "unsupported";
  }
  try {
    const opened = await workspaceRoot.open(browserPath);
    await using handle = opened.handle;
    const buffer = Buffer.allocUnsafe(Math.min(maxBytes, opened.stat.size));
    const bytesRead = await readFileWindowFully(handle, buffer, 0);
    return {
      buffer: buffer.subarray(0, bytesRead),
      canonicalPath: path
        .relative(workspaceRoot.rootReal, opened.realPath)
        .split(path.sep)
        .join("/"),
      stat: opened.stat,
    };
  } catch {
    return undefined;
  }
}

export type WorkspaceFileUpdateResult =
  | { status: "updated"; canonicalPath: string; hash: string; stat: WorkspacePathStat }
  | { status: "conflict"; currentHash: string }
  | { status: "unsafe" };

export async function updateWorkspaceFile(
  rootDir: string,
  browserPath: string,
  content: string,
  expectedHash: string,
  assertCurrent?: () => void,
): Promise<WorkspaceFileUpdateResult> {
  const workspaceRoot = await openWorkspaceRoot(rootDir);
  if (!workspaceRoot) {
    return { status: "unsafe" };
  }
  if ("access" in workspaceRoot) {
    throw new Error("This workspace host supports file previews but not conflict-safe editing");
  }
  // Serialize every low-frequency editor save. The same physical file can be
  // exposed through path aliases or nested workspace roots, so narrower queue
  // keys can let two routes accept one stale hash and overwrite each other.
  return await enqueueWorkspaceFileUpdate<WorkspaceFileUpdateResult>(async () => {
    let current: ReadResult;
    try {
      current = await workspaceRoot.read(browserPath);
    } catch {
      return { status: "unsafe" };
    }
    if (decodeUtf8Strict(current.buffer) === undefined) {
      return { status: "unsafe" };
    }
    const currentHash = createHash("sha256").update(current.buffer).digest("hex");
    if (currentHash !== expectedHash) {
      return { status: "conflict", currentHash };
    }
    assertCurrent?.();
    await workspaceRoot.write(browserPath, content, {
      encoding: "utf8",
      renameIdentity: "strict",
      assertBeforeMutation: assertCurrent,
    });
    const stat = await workspaceRoot.stat(browserPath);
    if (!stat.isFile) {
      return { status: "unsafe" };
    }
    return {
      status: "updated",
      canonicalPath: path
        .relative(workspaceRoot.rootReal, current.realPath)
        .split(path.sep)
        .join("/"),
      hash: createHash("sha256").update(content, "utf8").digest("hex"),
      stat,
    };
  });
}

export function decodeUtf8Strict(buffer: Buffer): string | undefined {
  // NUL bytes are valid UTF-8 but mark binary payloads we refuse to inline.
  if (buffer.includes(0)) {
    return undefined;
  }
  try {
    // ignoreBOM keeps a leading BOM in the decoded string so editor saves
    // round-trip the original bytes instead of silently dropping it.
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer);
  } catch {
    return undefined;
  }
}

/** Collapses `.` segments and separators into a canonical root-relative path. */
export function normalizeRelativePath(value: string | undefined): string {
  if (!value) {
    return "";
  }
  return value
    .replaceAll("\\", "/")
    .split("/")
    .filter((part) => part && part !== ".")
    .join("/");
}

/**
 * Lexical containment pre-check before any fs access; fs-safe re-verifies
 * against the realpathed root so symlinked escapes still fail later.
 */
export function resolveWorkspacePath(
  root: string | undefined,
  filePath: string,
): string | undefined {
  if (!root) {
    return undefined;
  }
  const resolved = path.resolve(root, filePath);
  return isPathInside(root, resolved) ? resolved : undefined;
}

/** Protocol timestamps are integer milliseconds. */
export function toUpdatedAtMs(mtimeMs: number): number {
  return Math.floor(mtimeMs);
}

export function sortDirents<T extends { name: string }>(dirents: readonly T[]): T[] {
  return dirents.toSorted((a, b) => a.name.localeCompare(b.name));
}

/** Directories first, then name order — the shared browser display order. */
export function sortWorkspaceEntries<T extends { kind: "file" | "directory"; name: string }>(
  entries: readonly T[],
): T[] {
  return entries.toSorted((a, b) => {
    if (a.kind !== b.kind) {
      return a.kind === "directory" ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });
}
