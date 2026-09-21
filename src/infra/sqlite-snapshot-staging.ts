import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { extractErrorCode } from "@openclaw/normalization-core/error-coercion";
import { getChildLogger } from "../logging/logger.js";
import { formatErrorMessage } from "./errors.js";
import { openNodeSqliteDatabase, resolveExistingSqliteFileUri } from "./node-sqlite.js";
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
  SQLITE_SNAPSHOT_CONTROL_FILES,
} from "./sqlite-readonly-location-cleanup.js";

const prefix = "openclaw-sqlite-readonly-v2-";
const suffix = "(?:[A-Za-z0-9]{6}|[\\da-f]{8}-[\\da-f]{4}-[\\da-f]{4}-[\\da-f]{4}-[\\da-f]{12})$";
const legacyMarker = new RegExp(`^openclaw-sqlite-readonly-[1-9]\\d*-${suffix}`, "u");
const tokenMarker = new RegExp(`^${prefix}${suffix}`, "u");
const tokenName = SQLITE_SNAPSHOT_CONTROL_FILES[0];
type ReclamationPass = { controller: AbortController; done: Promise<void> };
const pendingReclamations = new Map<string, ReclamationPass>();
const legacyAgeMs = 24 * 60 * 60 * 1000;
const currentAgeMs = 15 * 60 * 1000;
const reclamationByteBudget = 512 * 1024 * 1024;
const isStagingName = (name: string) => legacyMarker.test(name) || tokenMarker.test(name);
type SnapshotToken = (retiring?: boolean) => void;

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

function snapshotToken(directory: string, mode: "create" | "read" | "reclaim"): SnapshotToken {
  const location = path.join(directory, tokenName);
  // Check sidecars before SQLite may recover or remove a private journal.
  const family = SQLITE_SNAPSHOT_CONTROL_FILES.map((file) =>
    fs.lstatSync(path.join(directory, file), { throwIfNoEntry: false }),
  );
  const existing = family[0];
  if (
    family.some(
      (file) => file && (!file.isFile() || (process.getuid && file.uid !== process.getuid())),
    ) ||
    (!existing && mode !== "create" && !legacyMarker.test(path.basename(directory)))
  ) {
    throw new Error("SQLite snapshot token ownership is unknown");
  }
  // Shipped drivers may supply a legacy parent without a token. Cooperating
  // workers/reclaimers create the same inode; SQLite arbitrates admission.
  // CREATE never recreates a missing parent directory.
  const db = openNodeSqliteDatabase(existing ? resolveExistingSqliteFileUri(location) : location);
  const release: SnapshotToken = (retiring = false) => {
    if (!db.isOpen) {
      return;
    }
    if (retiring) {
      // Windows handles omit FILE_SHARE_DELETE: commit retirement while fenced,
      // then close for removal. Late workers reject the committed marker.
      if (!db.isTransaction) {
        db.exec("BEGIN IMMEDIATE");
      }
      db.exec("PRAGMA user_version=1; COMMIT");
    } else if (db.isTransaction) {
      // Bun can retain statements after close_v2; end the transaction now so
      // a released worker cannot keep its parent's retirement commit locked.
      db.exec("ROLLBACK");
    }
    db.close();
  };
  try {
    db.exec(
      `PRAGMA busy_timeout=0; ${mode === "create" ? "BEGIN IMMEDIATE" : mode === "reclaim" ? "BEGIN EXCLUSIVE" : "BEGIN; SELECT rootpage FROM sqlite_schema LIMIT 1"}`,
    );
    if (db.prepare("PRAGMA journal_mode").get()?.journal_mode !== "delete") {
      throw new Error("SQLite snapshot token journal mode is unknown");
    }
    const version = db.prepare("PRAGMA user_version").get()?.user_version;
    if (version !== 0 && (mode !== "reclaim" || version !== 1)) {
      throw new Error("SQLite snapshot parent retired; aborting snapshot allocation");
    }
    return release;
  } catch (error) {
    release();
    throw error;
  }
}

/** A private reader protects its bytes independently of the staging child. */
export function acquireSqliteSnapshotReadToken(directory: string): () => void {
  return snapshotToken(directory, "read");
}

function inspectSnapshot(
  directory: string,
  tokens: SnapshotToken[] | undefined,
  inheritedCutoff: number,
  layout = "",
): { bytes: number; newest: number } {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || (process.getuid && stat.uid !== process.getuid())) {
    throw new Error("Snapshot directory ownership is unknown");
  }
  const legacy = !layout && legacyMarker.test(path.basename(directory));
  // A current parent never shortens the compatibility grace of a legacy child.
  const cutoff = legacy ? Math.min(inheritedCutoff, Date.now() - legacyAgeMs) : inheritedCutoff;
  // Check all legacy activity without creating tokens, then repeat under locks.
  // Even creating an empty token would otherwise postpone a recent copy's expiry.
  if (legacy && tokens) {
    inspectSnapshot(directory, undefined, cutoff, layout);
  }
  if (!layout && tokens) {
    tokens.push(snapshotToken(directory, "reclaim"));
  }
  let bytes = 0;
  let newest = stat.mtimeMs;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const location = path.join(directory, entry.name);
    const item = fs.lstatSync(location);
    if (process.getuid && item.uid !== process.getuid()) {
      throw new Error("Snapshot file ownership is unknown");
    }
    // Coordination files are neither copied data nor evidence of legacy activity.
    if (
      !layout &&
      item.isFile() &&
      SQLITE_SNAPSHOT_CONTROL_FILES.some((file) => file === entry.name)
    ) {
      continue;
    }
    newest = Math.max(newest, item.mtimeMs);
    if (item.isDirectory()) {
      const nested = (!layout || layout === "openclaw") && isStagingName(entry.name);
      const childLayout = nested ? "" : [layout, entry.name].filter(Boolean).join("/");
      if (
        !nested &&
        !["openclaw", "openclaw-state", "openclaw-state/state"].includes(childLayout)
      ) {
        throw new Error("Unrecognized snapshot directory");
      }
      const child = inspectSnapshot(location, tokens, cutoff, childLayout);
      bytes += child.bytes;
      newest = Math.max(newest, child.newest);
    } else if (
      item.isFile() &&
      (layout === "openclaw-state/state"
        ? /^openclaw\.sqlite(?:-wal|-shm|-journal)?$/u.test(entry.name)
        : !layout &&
          /^(?:first|database\.sqlite(?:\.partial)?(?:-wal|-shm|-journal)?)$/u.test(entry.name))
    ) {
      bytes += item.size;
    } else {
      throw new Error("Unrecognized snapshot artifact");
    }
  }
  // Token ownership proves abandonment; age still gives terminating owners and
  // slow filesystems a bounded grace period before copied bytes are reclaimed.
  if (newest >= cutoff) {
    throw new Error(
      legacy
        ? "Legacy snapshot contains activity newer than 24 hours"
        : "Snapshot contains activity within the reclamation grace period",
    );
  }
  return { bytes, newest };
}

/** Reconcile only after the token process closed; active readers still fence reclamation. */
export function reconcileSqliteSnapshotRetirement(directory: string): void {
  if (!fs.lstatSync(directory, { throwIfNoEntry: false })) {
    return;
  }
  const tokens: SnapshotToken[] = [];
  try {
    // Explicit retirement has confirmed owner exit; nested legacy layouts keep their age clamp.
    inspectSnapshot(directory, tokens, Number.POSITIVE_INFINITY);
    for (const token of tokens) {
      token(true);
    }
  } finally {
    for (const token of tokens) {
      token();
    }
  }
}

export function* reclaimAbandonedSqliteSnapshots(root: string, report = warn): Generator<void> {
  if (stagingParent(root)) {
    return;
  }
  try {
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
      const tokens: SnapshotToken[] = [];
      try {
        const { bytes } = inspectSnapshot(
          directory,
          tokens,
          Date.now() - (legacy ? legacyAgeMs : currentAgeMs),
        );
        // Admit one oversized directory before spending the pass budget; otherwise
        // interrupted multi-gigabyte copies can never be reclaimed.
        if (admittedBytes > 0 && bytes > reclamationByteBudget - admittedBytes) {
          throw new Error("Snapshot reclamation byte budget exhausted for this pass");
        }
        admittedBytes += bytes;
        for (const token of tokens) {
          token(true);
        }
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
        for (const token of tokens) {
          token();
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

/** Token workers retain native handles; only the calling process owns byte cleanup. */
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
