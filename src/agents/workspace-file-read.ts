import path from "node:path";
import { sameFileIdentity } from "@openclaw/fs-safe/advanced";
import { getFsSafeNativeConfig } from "@openclaw/fs-safe/config";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { isRootFileMissingFailure } from "../infra/boundary-file-read.js";
import { hasErrnoCode } from "../infra/errno.js";
import { runFsSafeFilesystemTask } from "../infra/fs-safe-filesystem-worker.js";
import { FsSafeError } from "../infra/fs-safe.js";
import { resolveUserPath } from "../infra/home-dir.js";
import { decodeNativeWorkerFailure } from "../infra/worker-native-error.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { exactWorkspaceEntryExists } from "../memory/root-memory-files.js";
import { settleCurrentReadPreparations } from "../shared/current-read-authority.js";
import { getAgentWorkspaceAccess } from "./workspace-access.js";
import {
  DEFAULT_MEMORY_FILENAME,
  DEFAULT_USER_FILENAME,
  WORKSPACE_BOOTSTRAP_FILENAMES,
  type WorkspaceBootstrapFile,
  type WorkspaceBootstrapFileName,
} from "./workspace-bootstrap-policy.js";
import { MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES } from "./workspace-bootstrap-read.js";
import { readLocalWorkspaceFileWithGuards } from "./workspace-file-read-local.js";
import type {
  WorkspaceFileSourceIdentity,
  WorkspaceGuardedReadResult,
} from "./workspace-filesystem.types.js";
export { retryWorkspaceRead } from "./workspace-file-read-local.js";

const workspaceLogger = createSubsystemLogger("workspace");

// Loader-owned records retain the pinned-open identity through final session filtering.
const workspaceFileSourceIdentities = new WeakMap<object, WorkspaceFileSourceIdentity>();

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
  // Seed/publication comparisons already opt out of caching. Move their pinned
  // filesystem work off-thread without changing the warm bootstrap cache contract.
  if (params.useCache === false) {
    try {
      const { result } = await runFsSafeFilesystemTask({
        type: "workspace-read",
        nativeMode: getFsSafeNativeConfig().mode,
        input: { ...params, useCache: false },
      });
      if (result.ok) {
        return result;
      }
      const error =
        result.error === undefined ? undefined : decodeNativeWorkerFailure(result.error);
      return {
        ok: false,
        reason: result.reason,
        error:
          result.fsCode && error instanceof Error
            ? new FsSafeError(result.fsCode, error.message, {
                cause: error.cause,
                details: result.details,
              })
            : error,
      };
    } catch (error) {
      return { ok: false, reason: error instanceof RangeError ? "validation" : "io", error };
    }
  }

  return readLocalWorkspaceFileWithGuards(params);
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
