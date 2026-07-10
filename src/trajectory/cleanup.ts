// Trajectory cleanup helpers remove old trajectory files by retention policy.
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
import {
  canonicalizeTrajectoryPath as canonicalizePathForComparison,
  claimTrajectoryPathIncarnation,
  findTrajectoryPathOwnedBySession,
  mayTrajectoryPathBeRemovedBySession,
  reassignTrajectoryPathOwner,
  withTrajectoryPathLock,
} from "./writer-lifecycle.js";

type RemovedTrajectoryArtifact = {
  kind: "pointer" | "runtime";
  path: string;
};

type TrajectoryPointer = {
  runtimeFile: string;
};

function isPathWithinDir(parentDir: string, filePath: string): boolean {
  const resolvedParent = canonicalizePathForComparison(parentDir);
  const resolvedFile = canonicalizePathForComparison(filePath);
  return resolvedFile !== resolvedParent && isPathInside(resolvedParent, resolvedFile);
}

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

async function removeRegularFile(
  filePath: string,
  kind: RemovedTrajectoryArtifact["kind"],
): Promise<RemovedTrajectoryArtifact | null> {
  if (!isRegularNonSymlinkFile(filePath)) {
    return null;
  }
  try {
    await fs.promises.rm(filePath, { force: true });
  } catch {
    // Best-effort: a transiently busy/locked artifact should not block
    // removal of the remaining candidates (runtime file vs. pointer).
    return null;
  }
  return { kind, path: path.resolve(filePath) };
}

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
  // A pointer-declared path that merely sits inside the store dir is not proof
  // it belongs to this session (a stale/forged pointer can name any sibling
  // file there) — still require the basename+content match below.
  const expectedName = `${safeTrajectorySessionFileName(params.sessionId)}.jsonl`;
  if (path.basename(resolved) !== expectedName) {
    return false;
  }
  return runtimeFileStartsWithSessionEvent(resolved, params.sessionId);
}

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
  // The one shared, authoritative derivation for a collision-disambiguated
  // path: ask the registry what canonicalPath this exact sessionId owns,
  // rather than re-deriving the (wrong, un-suffixed) default candidate. Ownership
  // records are in-process-trusted, unlike a persisted pointer file, so this
  // candidate skips the basename/content heuristic below and is validated by
  // owner match alone, inside the lock.
  const registryOwnedPath = findTrajectoryPathOwnedBySession(params.sessionId);
  if (registryOwnedPath) {
    runtimeCandidates.add(registryOwnedPath);
  }
  const canRemovePointer = !restrictToStoreDir || isPathWithinDir(storeDir, pointerPath);
  // The runtime file and its pointer are one incarnation-owned artifact pair:
  // whichever canonical path this session actually owns is where BOTH must
  // retire/remove in the SAME locked turn, so a racing acquisition on that
  // exact path can never observe a half-deleted pair — a fresh pointer
  // published after this turn releases, or this turn's removal clobbering a
  // pointer a racing claim just published (round 4 P1).
  const primaryCanonicalPath =
    registryOwnedPath ?? canonicalizePathForComparison(defaultRuntimePath);
  let pointerHandledInPrimaryTurn = false;

  for (const runtimePath of runtimeCandidates) {
    const canonicalRuntimePath = canonicalizePathForComparison(runtimePath);
    const isRegistryOwnedCandidate = canonicalRuntimePath === registryOwnedPath;
    if (
      !isRegistryOwnedCandidate &&
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
    const removePointerHere = canRemovePointer && canonicalRuntimePath === primaryCanonicalPath;
    if (removePointerHere) {
      pointerHandledInPrimaryTurn = true;
    }
    const result = await withTrajectoryPathLock(canonicalRuntimePath, async () => {
      // Validate ownership from the registry's own record, not just the
      // pre-lock heuristic above: a concurrent reassignment could have moved
      // this canonical path to a different owner between that check and
      // lock admission, and no cross-session delete may ever go through.
      if (!mayTrajectoryPathBeRemovedBySession(canonicalRuntimePath, params.sessionId)) {
        return { runtime: null, pointer: null };
      }
      // Retire before unlinking, in the same locked turn: a writer's flush
      // turn queued behind this one must observe "retired" and no-op instead
      // of recreating the file we are about to remove (F1/F2/F5). Acquisition
      // shares this same lock (writer-lifecycle.ts), so no concurrent claim
      // can slip in between the retire and the unlink either (P1-A).
      claimTrajectoryPathIncarnation(canonicalRuntimePath, {
        ownerSessionId: params.sessionId,
        retired: true,
      });
      const runtime = await removeRegularFile(runtimePath, "runtime");
      const pointerRemoved = removePointerHere
        ? await removeRegularFile(pointerPath, "pointer")
        : null;
      return { runtime, pointer: pointerRemoved };
    });
    if (result.runtime) {
      removed.push(result.runtime);
    }
    if (result.pointer) {
      removed.push(result.pointer);
    }
  }

  // Fallback: none of the runtime candidates landed on primaryCanonicalPath's
  // own locked turn (e.g. mayRemoveRuntimeTarget rejected it) — still remove
  // the pointer, locked on the same canonical path a racing claim would use,
  // rather than the old fully-unlocked step this replaces.
  if (canRemovePointer && !pointerHandledInPrimaryTurn) {
    const deletedPointer = await withTrajectoryPathLock(primaryCanonicalPath, () =>
      removeRegularFile(pointerPath, "pointer"),
    );
    if (deletedPointer) {
      removed.push(deletedPointer);
    }
  }

  return removed;
}

/**
 * Reassigns a reused trajectory path's registry ownership from the previous
 * session id to the next one, without a generation bump: the file and any
 * in-flight writer for it remain valid, only the logical owner changes
 * (resetSessionEntryLifecycle's "reused transcript path" case, §3.6).
 */
export async function reassignSessionTrajectoryPathOwner(params: {
  previousSessionId: string;
  previousSessionFile?: string;
  nextSessionId: string;
  nextSessionFile: string;
}): Promise<void> {
  const previousCandidatePath = resolveTrajectoryFilePath({
    sessionFile: params.previousSessionFile,
    sessionId: params.previousSessionId,
  });
  const nextCandidatePath = resolveTrajectoryFilePath({
    sessionFile: params.nextSessionFile,
    sessionId: params.nextSessionId,
  });
  const previousCanonicalPath = canonicalizePathForComparison(previousCandidatePath);
  if (previousCanonicalPath !== canonicalizePathForComparison(nextCandidatePath)) {
    // Different canonical paths (e.g. an OPENCLAW_TRAJECTORY_DIR override
    // keyed by sessionId): nothing to reassign, the next session's own
    // recorder creation claims its path fresh.
    return;
  }
  await reassignTrajectoryPathOwner(previousCanonicalPath, {
    from: params.previousSessionId,
    to: params.nextSessionId,
  });
}

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
