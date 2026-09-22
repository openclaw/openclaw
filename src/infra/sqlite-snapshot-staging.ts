import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { extractErrorCode } from "@openclaw/normalization-core/error-coercion";
import { getChildLogger } from "../logging/logger.js";
import { formatErrorMessage } from "./errors.js";
import { markSqliteInspectionOperation } from "./sqlite-error-diagnostics.js";
import {
  createPrivateSqliteTempDirectorySync,
  resolvePrivateSqliteSnapshotStagingRoot,
} from "./sqlite-private-directory.js";
import {
  registerSnapshotTempDirectory,
  registerAsyncSnapshotTempDirectory,
  removeTempDirectory,
  removeTempDirectoryAsync,
  retainSnapshotWork,
  SqliteSnapshotCleanupError,
  retireSqliteSnapshotPayload,
} from "./sqlite-readonly-location-cleanup.js";
import {
  acquireSqliteSnapshotToken as snapshotToken,
  beginSqliteSnapshotRetirement,
  drainPendingSqliteSnapshotRootTokens,
  drainPendingSqliteSnapshotTokens,
  isSqliteSnapshotStagingName as isStagingName,
  SQLITE_SNAPSHOT_LEGACY_AGE_MS as legacyAgeMs,
  SQLITE_SNAPSHOT_LEGACY_MARKER as legacyMarker,
  SQLITE_SNAPSHOT_PREFIX as prefix,
} from "./sqlite-snapshot-retirement.js";
import type { SqliteStagingToken as SnapshotToken } from "./sqlite-staging-token.js";

type ReclamationPass = { controller: AbortController; done: Promise<void> };
const pendingReclamations = new Map<string, ReclamationPass>();
const currentAgeMs = 15 * 60 * 1000;
const reclamationByteBudget = 512 * 1024 * 1024;

function stagingParent(root: string): string | undefined {
  const parent = path.basename(root) === "openclaw" ? path.dirname(root) : root;
  return isStagingName(path.basename(parent)) ? parent : undefined;
}

function warn(message: string, error?: unknown): void {
  try {
    getChildLogger({ subsystem: "infra/sqlite-snapshot" }).warn(
      { errorCode: extractErrorCode(error) },
      message,
    );
  } catch {
    // Cleanup diagnostics must not prevent inspection or startup.
  }
}

/** A private reader protects its bytes independently of the staging child. */
export function acquireSqliteSnapshotReadToken(directory: string): () => void {
  return snapshotToken(directory, "read");
}

/** Reconcile only after the token process closed; active readers still fence reclamation. */
export function reconcileSqliteSnapshotRetirement(directory: string): void {
  drainPendingSqliteSnapshotTokens(directory);
  if (!fs.lstatSync(directory, { throwIfNoEntry: false })) {
    return;
  }
  // Explicit retirement has confirmed owner exit; nested legacy layouts keep their age clamp.
  const retirement = beginSqliteSnapshotRetirement(directory, { cutoff: Number.POSITIVE_INFINITY });
  try {
    retireSqliteSnapshotPayload(retirement);
  } finally {
    retirement.release();
  }
}

export function* reclaimAbandonedSqliteSnapshots(root: string, report = warn): Generator<void> {
  if (stagingParent(root)) {
    return;
  }
  try {
    drainPendingSqliteSnapshotRootTokens(root, (error) =>
      report("SQLite snapshot token close failed; retaining native cleanup custody.", error),
    );
    let admittedBytes = 0;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (admittedBytes >= reclamationByteBudget) {
        report("Stopped SQLite snapshot reclamation: byte budget exhausted for this pass.");
        break;
      }
      const legacy = legacyMarker.test(entry.name);
      if (!entry.isDirectory() || !isStagingName(entry.name)) {
        continue;
      }
      const directory = path.join(root, entry.name);
      let retirement: ReturnType<typeof beginSqliteSnapshotRetirement> | undefined;
      try {
        retirement = beginSqliteSnapshotRetirement(directory, {
          cutoff: Date.now() - (legacy ? legacyAgeMs : currentAgeMs),
        });
        const { bytes } = retirement;
        // Admit one oversized directory before spending the pass budget; otherwise
        // interrupted multi-gigabyte copies can never be reclaimed.
        if (admittedBytes > 0 && bytes > reclamationByteBudget - admittedBytes) {
          throw new Error("Snapshot reclamation byte budget exhausted for this pass");
        }
        admittedBytes += bytes;
        retireSqliteSnapshotPayload(retirement);
        const claimed = path.join(
          root,
          `${legacy ? `openclaw-sqlite-readonly-${process.pid}-` : prefix}${randomUUID()}`,
        );
        fs.renameSync(directory, claimed);
        if (!removeTempDirectory(claimed)) {
          throw new Error("Snapshot removal failed; check private cache permissions");
        }
        report(`Reclaimed ${bytes} bytes of interrupted SQLite snapshot data.`);
      } catch (error) {
        report(`Skipped SQLite snapshot reclamation: ${formatErrorMessage(error)}`, error);
      } finally {
        try {
          retirement?.release();
        } catch (error) {
          report("SQLite snapshot token close failed; retaining native cleanup custody.", error);
        }
      }
      // Yield only after retirement, removal, and token release settle together.
      yield;
    }
  } catch (error) {
    report("SQLite snapshot reclamation failed; check private cache permissions.", error);
  }
}

export function reclaimAbandonedSqliteSnapshotsAsync(
  root = resolvePrivateSqliteSnapshotStagingRoot(),
): Promise<void> {
  if (stagingParent(root) || pendingReclamations.has(root)) {
    return pendingReclamations.get(root)?.done ?? Promise.resolve();
  }
  const controller = new AbortController();
  const pass: ReclamationPass = {
    controller,
    done: (async () => {
      try {
        const { runSqliteReadOnlyWorker } = await import("./sqlite-readonly-worker.js");
        if (!controller.signal.aborted) {
          for (const message of await runSqliteReadOnlyWorker(root, {
            mode: "reclaim",
            signal: controller.signal,
          })) {
            warn(message);
          }
        }
      } catch (error) {
        warn("SQLite snapshot reclamation worker failed; continuing without cache cleanup.", error);
      } finally {
        pendingReclamations.delete(root);
      }
    })(),
  };
  pendingReclamations.set(root, pass);
  return pass.done;
}

export function sqliteSnapshotStagingError(
  tempDir: string,
  cause: unknown,
  allocation = false,
): unknown {
  markSqliteInspectionOperation(cause, "snapshot");
  for (let depth = 0, error = cause; depth < 8 && error instanceof Error; depth += 1) {
    const { code, errcode, path: errorPath }: NodeJS.ErrnoException & { errcode?: unknown } = error;
    // SQLite FULL and IOERR_WRITE/FSYNC/DIR_FSYNC identify destination writes.
    if (
      allocation ||
      ["ENOSPC", "EDQUOT"].includes(code ?? "") ||
      (typeof errcode === "number" && [13, 778, 1034, 1290].includes(errcode)) ||
      `${errorPath ?? ""}${path.sep}`.startsWith(`${tempDir}${path.sep}`)
    ) {
      const message = `${cause instanceof Error ? cause.message : String(cause)}${typeof errcode === "number" ? ` (SQLite errcode=${errcode})` : ""}; snapshot staging root ${allocation ? tempDir : path.dirname(tempDir)}: free disk space/quota or set XDG_CACHE_HOME to a writable filesystem`;
      return new Error(message, { cause });
    }
    error = error.cause;
  }
  return cause;
}

export async function createSqliteSnapshotStagingDirectory(
  stagingRoot = resolvePrivateSqliteSnapshotStagingRoot(),
  allowLegacyWorker = false,
  signal?: AbortSignal,
  asynchronousCleanup = false,
): Promise<string> {
  signal?.throwIfAborted();
  try {
    return await allocateSqliteSnapshotStagingDirectory(
      stagingRoot,
      allowLegacyWorker,
      signal,
      asynchronousCleanup,
    );
  } catch (error) {
    if (
      error instanceof SqliteSnapshotCleanupError ||
      (asynchronousCleanup && error instanceof AggregateError)
    ) {
      throw error;
    }
    signal?.throwIfAborted();
    throw sqliteSnapshotStagingError(stagingRoot, error, true);
  }
}

async function allocateSqliteSnapshotStagingDirectory(
  root = resolvePrivateSqliteSnapshotStagingRoot(),
  allowLegacyWorker = false,
  signal?: AbortSignal,
  asynchronousCleanup = false,
): Promise<string> {
  signal?.throwIfAborted();
  if (asynchronousCleanup) {
    const controller = new AbortController();
    return retainSnapshotWork(
      (async () => {
        const { allocateWorkerOwnedSqliteSnapshotDirectory } =
          await import("./sqlite-snapshot-staging-owner.js");
        signal?.throwIfAborted();
        controller.signal.throwIfAborted();
        const owned = await allocateWorkerOwnedSqliteSnapshotDirectory(
          root,
          allowLegacyWorker,
          signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
        );
        registerAsyncSnapshotTempDirectory(owned.directory, owned.retire);
        if (signal?.aborted || controller.signal.aborted) {
          if (!(await removeTempDirectoryAsync(owned.directory))) {
            throw new SqliteSnapshotCleanupError(
              `SQLite snapshot cleanup failed: ${owned.directory}`,
            );
          }
          signal?.throwIfAborted();
          controller.signal.throwIfAborted();
        }
        return owned.directory;
      })(),
      () => controller.abort(new Error("SQLite snapshot allocation stopped")),
    );
  }
  return createSqliteSnapshotStagingDirectorySync(root, allowLegacyWorker);
}

export function createSqliteSnapshotStagingDirectorySync(
  root = resolvePrivateSqliteSnapshotStagingRoot(),
  allowLegacyWorker = false,
): string {
  const owned = createSqliteSnapshotStagingTokenSync(root, allowLegacyWorker);
  registerSnapshotTempDirectory(owned.directory, owned.release);
  return owned.directory;
}

/** Token workers remove disposable payload under their own native retirement fences. */
export function createSqliteSnapshotStagingTokenSync(
  root = resolvePrivateSqliteSnapshotStagingRoot(),
  allowLegacyWorker = false,
): { directory: string; release: SnapshotToken } {
  // A shared parent token fences admission until the child's own token is held.
  // No mkdir of root: a late orphan must abort if reclamation already won.
  const parentDirectory = stagingParent(root);
  const parent = parentDirectory ? snapshotToken(parentDirectory, "read") : undefined;
  let directory: string | undefined;
  try {
    // A selected installation may launch a worker without token admission.
    directory = createPrivateSqliteTempDirectorySync(
      root,
      allowLegacyWorker ? `openclaw-sqlite-readonly-${process.pid}-` : prefix,
    );
    return { directory, release: snapshotToken(directory, "create") };
  } catch (error) {
    if (directory) {
      removeTempDirectory(directory);
    }
    throw error;
  } finally {
    parent?.();
  }
}
