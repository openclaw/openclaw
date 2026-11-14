import syncFs from "node:fs";
import path from "node:path";
import { sameFileIdentity, type FileIdentityStat } from "@openclaw/fs-safe/advanced";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { isRootFileMissingFailure, openRootFile } from "../infra/boundary-file-read.js";
import { hasErrnoCode } from "../infra/errno.js";
import { FsSafeError } from "../infra/fs-safe.js";
import { resolveUserPath } from "../infra/home-dir.js";
import { retryAsync } from "../infra/retry.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { exactWorkspaceEntryExists } from "../memory/root-memory-files.js";
import { settleCurrentReadPreparations } from "../shared/current-read-authority.js";
import { getAgentWorkspaceAccess } from "./workspace-access.js";
import {
  DEFAULT_IDENTITY_FILENAME,
  DEFAULT_MEMORY_FILENAME,
  DEFAULT_USER_FILENAME,
  WORKSPACE_BOOTSTRAP_FILENAMES,
  type WorkspaceBootstrapFile,
  type WorkspaceBootstrapFileName,
} from "./workspace-bootstrap-policy.js";
import {
  projectWorkspaceBootstrapFileForPrompt,
  readWorkspaceBootstrapFile,
  workspaceBootstrapFileReadLimit,
} from "./workspace-bootstrap-read.js";
import { readWorkspaceFileCache, writeWorkspaceFileCache } from "./workspace-file-cache.js";

const workspaceLogger = createSubsystemLogger("workspace");

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

type WorkspaceFileSourceIdentity = readonly [
  canonicalPath: string,
  stat: FileIdentityStat | undefined,
  workspaceRelativePath?: string,
];
// Loader-owned records retain the pinned-open identity through final session filtering.
const workspaceFileSourceIdentities = new WeakMap<object, WorkspaceFileSourceIdentity>();

type WorkspaceGuardedReadResult =
  | { ok: true; content: string; sourceIdentity: WorkspaceFileSourceIdentity }
  | { ok: false; reason: "path" | "validation" | "io"; error?: unknown };

function workspaceFileIdentity(
  stat: syncFs.Stats,
  identity: FileIdentityStat,
  canonicalPath: string,
): string {
  // ctimeMs catches in-place edits that restore mtime (sync/restore/editor tooling);
  // matches the freshness pattern in assistant-avatar-cache.ts and plugin-registry-snapshot.ts.
  return `${canonicalPath}|${identity.dev}:${identity.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}

export function createLoadedWorkspaceBootstrapFile(
  name: WorkspaceBootstrapFile["name"],
  filePath: string,
  loaded: Extract<WorkspaceGuardedReadResult, { ok: true }>,
  personalUser?: true,
): WorkspaceBootstrapFile {
  const file: WorkspaceBootstrapFile = {
    name,
    path: filePath,
    content: loaded.content,
    missing: false,
    ...(personalUser ? { personalUser } : {}),
  };
  workspaceFileSourceIdentities.set(file, loaded.sourceIdentity);
  return file;
}

/** Remote source recorded by the successful read, unavailable on hook-created copies. */
export function getWorkspaceFileSourceRelativePath(file: object): string | undefined {
  return workspaceFileSourceIdentities.get(file)?.[2];
}

export function workspaceFilesShareSourceIdentity(left: object, right: object): boolean {
  const leftIdentity = workspaceFileSourceIdentities.get(left);
  const rightIdentity = workspaceFileSourceIdentities.get(right);
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
  /** Raw publication and cache reads must retain the original inline avatar. */
  projectForPrompt?: boolean;
  /** Identity-scoped files must not alias another profile through parent symlinks. */
  rejectAliases?: boolean;
}): Promise<WorkspaceGuardedReadResult> {
  const name = path.basename(params.filePath);
  const maxBytes = workspaceBootstrapFileReadLimit(name);
  const project = (content: string) =>
    params.projectForPrompt && name === DEFAULT_IDENTITY_FILENAME
      ? projectWorkspaceBootstrapFileForPrompt(content, name)
      : content;
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
          maxBytes,
        },
      );
      assertCurrent();
      if (params.rejectAliases && workspaceRelativePath !== filePath.replaceAll(path.sep, "/")) {
        return { ok: false, reason: "validation" };
      }
      if (data.length > maxBytes) {
        throw new RangeError(`Workspace bootstrap file exceeds its read bound: ${filePath}`);
      }
      return {
        ok: true,
        content: project(data.toString("utf-8")),
        sourceIdentity: [canonicalPath, undefined, workspaceRelativePath],
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
      try {
        // Aliases can share a raw cache entry but retain the selected file's bound.
        if (opened.stat.size > maxBytes) {
          throw new RangeError(`File exceeds ${maxBytes} bytes`);
        }
        const promptFileName = params.projectForPrompt ? name : undefined;
        const cached =
          params.useCache === false
            ? undefined
            : readWorkspaceFileCache(opened.path, identity, promptFileName);
        if (cached !== undefined) {
          return { ok: true, content: cached, sourceIdentity };
        }
        const content = await readWorkspaceBootstrapFile(opened.fd, name);
        if (params.useCache !== false) {
          writeWorkspaceFileCache({ filePath: opened.path, content, identity });
          const prepared = readWorkspaceFileCache(opened.path, identity, promptFileName);
          if (prepared !== undefined) {
            return { ok: true, content: prepared, sourceIdentity };
          }
        }
        return { ok: true, content: project(content), sourceIdentity };
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

export async function loadWorkspaceBootstrapFiles(
  dir: string,
  names?: readonly WorkspaceBootstrapFileName[],
): Promise<WorkspaceBootstrapFile[]> {
  const resolvedDir = resolveUserPath(dir);
  const access = getAgentWorkspaceAccess(resolvedDir);
  // Cache hits still open files to validate identity, so select names before I/O.
  const entries = WORKSPACE_BOOTSTRAP_FILENAMES.filter(
    (name) => names === undefined || names.includes(name),
  ).map((name) => ({ name, filePath: path.join(resolvedDir, name) }));

  // The canonical list bounds fan-out. Join every read before releasing workspace
  // access on failure, then project results in prompt order, not completion order.
  const loadedFiles = await settleCurrentReadPreparations(
    entries.map(async (entry) => {
      if (
        !access &&
        (entry.name === DEFAULT_MEMORY_FILENAME || entry.name === DEFAULT_USER_FILENAME) &&
        // Lookup failures still need a guarded read for content or an unreadable diagnostic.
        !(await exactWorkspaceEntryExists(resolvedDir, entry.name).catch(() => true))
      ) {
        return undefined;
      }
      const loaded = await readWorkspaceFileWithGuards({
        filePath: entry.filePath,
        workspaceDir: resolvedDir,
        projectForPrompt: true,
      });
      return { entry, loaded };
    }),
  );
  const result: WorkspaceBootstrapFile[] = [];
  for (const file of loadedFiles) {
    if (!file) {
      continue;
    }
    const { entry, loaded } = file;
    if (loaded.ok) {
      result.push(createLoadedWorkspaceBootstrapFile(entry.name, entry.filePath, loaded));
    } else if (isRootFileMissingFailure(loaded)) {
      if (entry.name === DEFAULT_MEMORY_FILENAME || entry.name === DEFAULT_USER_FILENAME) {
        continue;
      }
      result.push({ name: entry.name, path: entry.filePath, missing: true });
    } else {
      const fallbackReason = `workspace file could not be read (${loaded.reason})`;
      const rawReason = loaded.error instanceof Error ? loaded.error.message : fallbackReason;
      const reason = truncateUtf16Safe(
        rawReason.replaceAll(/\s+/gu, " ").trim() || fallbackReason,
        300,
      );
      workspaceLogger.warn("Workspace bootstrap file is unreadable.", {
        fileName: entry.name,
        filePath: entry.filePath,
        reason,
        consoleMessage: `Workspace bootstrap file is unreadable: file=${entry.filePath} reason=${reason}`,
      });
      result.push({
        name: entry.name,
        path: entry.filePath,
        content: `[UNREADABLE: ${reason}]`,
        missing:
          loaded.error instanceof FsSafeError &&
          (loaded.error.code === "symlink" || loaded.error.code === "outside-workspace"),
      });
    }
  }
  return result;
}
