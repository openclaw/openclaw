/** Boundary-safe workspace reads and the source identity of the bytes returned. */
import { createHash } from "node:crypto";
import syncFs from "node:fs";
import path from "node:path";
import { sameFileIdentity, type FileIdentityStat } from "@openclaw/fs-safe/advanced";
import { openRootFile } from "../infra/boundary-file-read.js";
import { hasErrnoCode } from "../infra/errno.js";
import { retryAsync } from "../infra/retry.js";
import { getAgentWorkspaceAccess } from "./workspace-access.js";
import {
  MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES,
  readWorkspaceBootstrapFile,
} from "./workspace-bootstrap-read.js";
import { readWorkspaceFileCache, writeWorkspaceFileCache } from "./workspace-file-cache.js";

const TRANSIENT_WORKSPACE_READ_CODES = new Set(["EAGAIN", "EWOULDBLOCK", "EINTR"]);
const TRANSIENT_WORKSPACE_READ_ERRNOS = new Set([-11, -4]);
const TRANSIENT_WORKSPACE_READ_MESSAGE = /Unknown system error -(?:11|4)\b/i;

type WorkspaceFileSourceIdentity = readonly [
  canonicalPath: string,
  stat: FileIdentityStat | undefined,
  exactIdentity: string,
  workspaceRelativePath?: string,
];
// Loader-owned records retain the pinned-open identity through final session filtering.
const workspaceFileSourceIdentities = new WeakMap<object, WorkspaceFileSourceIdentity>();

/**
 * Read workspace files via boundary-safe open and cache by inode/dev/size/mtime/ctime identity.
 */
type WorkspaceGuardedReadResult =
  | { ok: true; content: string; sourceIdentity: WorkspaceFileSourceIdentity }
  | { ok: false; reason: "path" | "validation" | "io"; error?: unknown };

function workspaceFileIdentity(stat: syncFs.Stats, canonicalPath: string): string {
  // ctimeMs catches in-place edits that restore mtime (sync/restore/editor tooling);
  // matches the freshness pattern in assistant-avatar-cache.ts and plugin-registry-snapshot.ts.
  return `${canonicalPath}|${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}

export function setWorkspaceFileSourceIdentity(
  file: object,
  sourceIdentity: WorkspaceFileSourceIdentity,
): void {
  workspaceFileSourceIdentities.set(file, sourceIdentity);
}

function getWorkspaceFileSourceIdentity(file: object): WorkspaceFileSourceIdentity | undefined {
  return workspaceFileSourceIdentities.get(file);
}

/** Remote source recorded by the successful read, unavailable on hook-created copies. */
export function getWorkspaceFileSourceRelativePath(file: object): string | undefined {
  return getWorkspaceFileSourceIdentity(file)?.[3];
}

export function workspaceFileSourceIdentitiesMatch(left: object, right: object): boolean {
  const leftIdentity = getWorkspaceFileSourceIdentity(left);
  const rightIdentity = getWorkspaceFileSourceIdentity(right);
  return leftIdentity?.[2] === rightIdentity?.[2];
}

export function workspaceFilesShareSourceIdentity(left: object, right: object): boolean {
  const leftIdentity = getWorkspaceFileSourceIdentity(left);
  const rightIdentity = getWorkspaceFileSourceIdentity(right);
  if (!leftIdentity || !rightIdentity) {
    return false;
  }
  return (
    leftIdentity[0] === rightIdentity[0] ||
    (leftIdentity[1] !== undefined &&
      rightIdentity[1] !== undefined &&
      sameFileIdentity(leftIdentity[1], rightIdentity[1]))
  );
}

export async function readWorkspaceFileWithGuards(params: {
  filePath: string;
  workspaceDir: string;
  useCache?: boolean;
  /** Identity-scoped files must not alias another profile through parent symlinks. */
  rejectAliases?: boolean;
}): Promise<WorkspaceGuardedReadResult> {
  const access = getAgentWorkspaceAccess(params.workspaceDir);
  if (access) {
    if (!access.bridge.readFileWithSource) {
      throw new Error("Workspace bootstrap source identity is unavailable");
    }
    const filePath = path.relative(params.workspaceDir, params.filePath);
    const assertCurrent = () => {
      if (getAgentWorkspaceAccess(params.workspaceDir) !== access) {
        throw new Error("Workspace access changed while loading bootstrap files");
      }
    };
    try {
      const { data, canonicalPath, workspaceRelativePath } = await access.bridge.readFileWithSource(
        {
          filePath,
          maxBytes: MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES,
        },
      );
      assertCurrent();
      if (params.rejectAliases && workspaceRelativePath !== filePath.replaceAll(path.sep, "/")) {
        return { ok: false, reason: "validation" };
      }
      if (data.length > MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES) {
        throw new RangeError(`Workspace bootstrap file exceeds its read bound: ${filePath}`);
      }
      return {
        ok: true,
        content: data.toString("utf-8"),
        sourceIdentity: [
          canonicalPath,
          undefined,
          `${canonicalPath}:${createHash("sha256").update(data).digest("hex")}:${JSON.stringify(workspaceRelativePath)}`,
          workspaceRelativePath,
        ],
      };
    } catch (error) {
      assertCurrent();
      if (hasErrnoCode(error, "ENOENT")) {
        return { ok: false, reason: "path", error };
      }
      return { ok: false, reason: error instanceof RangeError ? "validation" : "io", error };
    }
  }
  try {
    // A transient FS race (EAGAIN/EWOULDBLOCK/EINTR under load) on the open or
    // read must not drop the agent's bootstrap file for the turn — this reader
    // runs every turn for AGENTS/SOUL/TOOLS/etc. Retry the whole open+read so
    // each attempt uses a fresh fd (retrying readFileSync on the same fd could
    // return truncated content after a partial read); the inode-identity guard
    // in openRootFile still protects against a swapped file between attempts.
    return await retryAsync(
      async () => {
        const opened = await openRootFile({
          absolutePath: params.filePath,
          rootPath: params.workspaceDir,
          boundaryLabel: "workspace root",
          symlinks: params.rejectAliases ? "reject" : "follow-parents-within-root",
        });
        if (!opened.ok) {
          // Boundary resolution can report transient IO as "validation", while
          // pinned open failures use "io". Classify the underlying error so
          // deterministic path and validation failures still return unchanged.
          if (isTransientWorkspaceReadError(opened.error)) {
            throw opened.error;
          }
          return opened;
        }

        const identity = workspaceFileIdentity(opened.stat, opened.path);
        const sourceIdentity = [opened.path, opened.stat, identity] as const;
        const cached =
          params.useCache === false ? undefined : readWorkspaceFileCache(opened.path, identity);
        if (cached !== undefined) {
          syncFs.closeSync(opened.fd);
          return { ok: true, content: cached, sourceIdentity };
        }

        try {
          const content = await readWorkspaceBootstrapFile(opened.fd);
          if (params.useCache !== false) {
            writeWorkspaceFileCache({ filePath: opened.path, content, identity });
          }
          return { ok: true, content, sourceIdentity };
        } finally {
          syncFs.closeSync(opened.fd);
        }
      },
      {
        attempts: 3,
        minDelayMs: 50,
        maxDelayMs: 50,
        shouldRetry: (err) => isTransientWorkspaceReadError(err),
      },
    );
  } catch (error) {
    // Non-transient read failure, or transient retries exhausted.
    return { ok: false, reason: error instanceof RangeError ? "validation" : "io", error };
  }
}

export function isTransientWorkspaceReadError(error: unknown): boolean {
  if (error && typeof error === "object") {
    if (
      "code" in error &&
      typeof error.code === "string" &&
      TRANSIENT_WORKSPACE_READ_CODES.has(error.code)
    ) {
      return true;
    }
    if (
      "errno" in error &&
      typeof error.errno === "number" &&
      TRANSIENT_WORKSPACE_READ_ERRNOS.has(error.errno)
    ) {
      return true;
    }
  }
  return error instanceof Error && TRANSIENT_WORKSPACE_READ_MESSAGE.test(error.message);
}
