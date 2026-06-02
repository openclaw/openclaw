import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveSessionFilePath } from "../config/sessions/paths.js";
import { isPathInside } from "../infra/path-guards.js";
import {
  resolveTrajectoryFilePath,
  resolveTrajectoryPointerFilePath,
  safeTrajectorySessionFileName,
} from "./paths.js";

export type RemovedTrajectoryArtifact = {
  kind: "pointer" | "runtime";
  path: string;
};

type TrajectoryPointer = {
  runtimeFile: string;
};

/** Resolves paths for deletion checks while tolerating already-removed files. */
function canonicalizePathForComparison(filePath: string): string {
  const resolved = path.resolve(filePath);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

/** Checks descendant paths after realpath normalization to avoid symlink escapes. */
function isPathWithinDir(parentDir: string, filePath: string): boolean {
  const resolvedParent = canonicalizePathForComparison(parentDir);
  const resolvedFile = canonicalizePathForComparison(filePath);
  return resolvedFile !== resolvedParent && isPathInside(resolvedParent, resolvedFile);
}

/** Accepts only regular files so cleanup never follows a sidecar symlink target. */
function isRegularNonSymlinkFile(filePath: string): boolean {
  try {
    const lst = fs.lstatSync(filePath);
    if (!lst.isFile() || lst.isSymbolicLink()) {
      return false;
    }
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/** Reads a trajectory pointer only when it matches the deleted session contract. */
function readTrajectoryPointerFile(
  pointerPath: string,
  sessionId: string,
): TrajectoryPointer | null {
  if (!isRegularNonSymlinkFile(pointerPath)) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(pointerPath, "utf8"));
    if (!isRecord(parsed)) {
      return null;
    }
    if (
      parsed.traceSchema !== "openclaw-trajectory-pointer" ||
      parsed.schemaVersion !== 1 ||
      parsed.sessionId !== sessionId ||
      typeof parsed.runtimeFile !== "string" ||
      !parsed.runtimeFile.trim()
    ) {
      return null;
    }
    return { runtimeFile: path.resolve(parsed.runtimeFile) };
  } catch {
    return null;
  }
}

/** Reads a small prefix to identify sidecar ownership without loading large traces. */
function readFirstNonEmptyLine(filePath: string): string | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, "r");
    const buffer = Buffer.alloc(64 * 1024);
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (bytesRead <= 0) {
      return null;
    }
    for (const line of buffer.subarray(0, bytesRead).toString("utf8").split(/\r?\n/u)) {
      const trimmed = line.trim();
      if (trimmed) {
        return trimmed;
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore best-effort cleanup close failures.
      }
    }
  }
}

/** Confirms an external-looking runtime file starts with the target session event. */
function runtimeFileStartsWithSessionEvent(filePath: string, sessionId: string): boolean {
  if (!isRegularNonSymlinkFile(filePath)) {
    return false;
  }
  const firstLine = readFirstNonEmptyLine(filePath);
  if (!firstLine) {
    return false;
  }
  try {
    const parsed: unknown = JSON.parse(firstLine);
    return (
      isRecord(parsed) &&
      parsed.traceSchema === "openclaw-trajectory" &&
      parsed.schemaVersion === 1 &&
      parsed.source === "runtime" &&
      parsed.sessionId === sessionId
    );
  } catch {
    return false;
  }
}

/** Removes one validated sidecar and reports the absolute path that was deleted. */
async function removeRegularFile(
  filePath: string,
  kind: RemovedTrajectoryArtifact["kind"],
): Promise<RemovedTrajectoryArtifact | null> {
  if (!isRegularNonSymlinkFile(filePath)) {
    return null;
  }
  await fs.promises.rm(filePath, { force: true });
  return { kind, path: path.resolve(filePath) };
}

/** Reconstructs the session file path from cleanup metadata, returning null on stale inputs. */
function resolveRemovedSessionFile(params: {
  sessionId: string;
  sessionFile?: string;
  storePath: string;
}): string | null {
  try {
    return resolveSessionFilePath(
      params.sessionId,
      params.sessionFile ? { sessionFile: params.sessionFile } : undefined,
      { sessionsDir: path.dirname(params.storePath) },
    );
  } catch {
    return null;
  }
}

/** Enforces which runtime sidecars are safe to delete for a removed session. */
function mayRemoveRuntimeTarget(params: {
  defaultRuntimePath: string;
  filePath: string;
  sessionId: string;
  storeDir: string;
  restrictToStoreDir: boolean;
}): boolean {
  const resolved = canonicalizePathForComparison(params.filePath);
  const withinStoreDir = isPathWithinDir(params.storeDir, resolved);
  if (canonicalizePathForComparison(params.defaultRuntimePath) === resolved) {
    return !params.restrictToStoreDir || withinStoreDir;
  }
  if (params.restrictToStoreDir && withinStoreDir) {
    return true;
  }
  const expectedName = `${safeTrajectorySessionFileName(params.sessionId)}.jsonl`;
  if (path.basename(resolved) !== expectedName) {
    return false;
  }
  return runtimeFileStartsWithSessionEvent(resolved, params.sessionId);
}

/** Removes trajectory pointer/runtime sidecars for one deleted session. */
export async function removeSessionTrajectoryArtifacts(params: {
  sessionId: string;
  sessionFile?: string;
  storePath: string;
  restrictToStoreDir?: boolean;
}): Promise<RemovedTrajectoryArtifact[]> {
  const sessionFile = resolveRemovedSessionFile(params);
  if (!sessionFile) {
    return [];
  }
  const storeDir = path.dirname(path.resolve(params.storePath));
  const restrictToStoreDir = params.restrictToStoreDir === true;
  const removed: RemovedTrajectoryArtifact[] = [];
  const pointerPath = resolveTrajectoryPointerFilePath(sessionFile);
  const pointer = readTrajectoryPointerFile(pointerPath, params.sessionId);
  const defaultRuntimePath = resolveTrajectoryFilePath({
    env: {},
    sessionFile,
    sessionId: params.sessionId,
  });
  const runtimeCandidates = new Set<string>([defaultRuntimePath]);
  if (pointer?.runtimeFile) {
    runtimeCandidates.add(pointer.runtimeFile);
  }

  for (const runtimePath of runtimeCandidates) {
    if (
      !mayRemoveRuntimeTarget({
        defaultRuntimePath,
        filePath: runtimePath,
        sessionId: params.sessionId,
        storeDir,
        restrictToStoreDir,
      })
    ) {
      continue;
    }
    const deleted = await removeRegularFile(runtimePath, "runtime");
    if (deleted) {
      removed.push(deleted);
    }
  }

  if (!restrictToStoreDir || isPathWithinDir(storeDir, pointerPath)) {
    const deletedPointer = await removeRegularFile(pointerPath, "pointer");
    if (deletedPointer) {
      removed.push(deletedPointer);
    }
  }

  return removed;
}

/** Removes trajectory sidecars for sessions no longer referenced by the store. */
export async function removeRemovedSessionTrajectoryArtifacts(params: {
  removedSessionFiles: Iterable<[string, string | undefined]>;
  referencedSessionIds: ReadonlySet<string>;
  storePath: string;
  restrictToStoreDir?: boolean;
}): Promise<RemovedTrajectoryArtifact[]> {
  const removed: RemovedTrajectoryArtifact[] = [];
  for (const [sessionId, sessionFile] of params.removedSessionFiles) {
    if (params.referencedSessionIds.has(sessionId)) {
      continue;
    }
    removed.push(
      ...(await removeSessionTrajectoryArtifacts({
        sessionId,
        sessionFile,
        storePath: params.storePath,
        restrictToStoreDir: params.restrictToStoreDir,
      })),
    );
  }
  return removed;
}
