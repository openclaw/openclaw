import syncFs from "node:fs";
import type { FileIdentityStat } from "@openclaw/fs-safe/advanced";
import { openRootFile } from "../infra/boundary-file-read.js";
import { retryAsync } from "../infra/retry.js";
import { readWorkspaceBootstrapFile } from "./workspace-bootstrap-read.js";
import { readWorkspaceFileCache, writeWorkspaceFileCache } from "./workspace-file-cache.js";
import type { WorkspaceGuardedReadResult } from "./workspace-filesystem.types.js";

const TRANSIENT_WORKSPACE_READ_CODES = new Set(["EAGAIN", "EWOULDBLOCK", "EINTR"]);
const TRANSIENT_WORKSPACE_READ_ERRNOS = new Set([-11, -4]);
const TRANSIENT_WORKSPACE_READ_MESSAGE = /Unknown system error -(?:11|4)\b/i;

export function retryWorkspaceRead<T>(operation: () => Promise<T>): Promise<T> {
  return retryAsync(operation, {
    attempts: 3,
    minDelayMs: 50,
    maxDelayMs: 50,
    shouldRetry: (error) => isTransientWorkspaceReadError(error),
  });
}

function workspaceFileIdentity(
  stat: syncFs.Stats,
  identity: FileIdentityStat,
  canonicalPath: string,
): string {
  // ctimeMs catches in-place edits that restore mtime (sync/restore/editor tooling);
  // matches the freshness pattern in assistant-avatar-cache.ts and plugin-registry-snapshot.ts.
  return `${canonicalPath}|${identity.dev}:${identity.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}

export async function readLocalWorkspaceFileWithGuards(params: {
  filePath: string;
  workspaceDir: string;
  useCache?: boolean;
  rejectAliases?: boolean;
}): Promise<WorkspaceGuardedReadResult> {
  try {
    // A transient FS race (EAGAIN/EWOULDBLOCK/EINTR under load) on the open or
    // read must not drop the agent's bootstrap file for the turn — this reader
    // runs every turn for AGENTS/SOUL/TOOLS/etc. Retry the whole open+read so
    // each attempt uses a fresh fd (retrying readFileSync on the same fd could
    // return truncated content after a partial read); the inode-identity guard
    // in openRootFile still protects against a swapped file between attempts.
    return await retryWorkspaceRead(async () => {
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

      const identity = workspaceFileIdentity(opened.stat, opened.exactIdentity, opened.path);
      const sourceIdentity = [opened.path, opened.exactIdentity] as const;
      const cached =
        params.useCache === false ? undefined : readWorkspaceFileCache(opened.path, identity);
      try {
        const content = cached ?? (await readWorkspaceBootstrapFile(opened.fd));
        if (cached === undefined && params.useCache !== false) {
          writeWorkspaceFileCache({ filePath: opened.path, content, identity });
        }
        return { ok: true, content, sourceIdentity };
      } finally {
        syncFs.closeSync(opened.fd);
      }
    });
  } catch (error) {
    // Non-transient read failure, or transient retries exhausted.
    return { ok: false, reason: error instanceof RangeError ? "validation" : "io", error };
  }
}

function isTransientWorkspaceReadError(error: unknown): boolean {
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
