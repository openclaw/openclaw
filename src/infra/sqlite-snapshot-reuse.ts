import fs, { type BigIntStats } from "node:fs";
import path from "node:path";
import {
  createRetainedOperation,
  mapRetainedOperation,
  type RetainedOperation,
} from "@openclaw/worker-runtime/lifecycle";
import { getChildLogger } from "../logging/logger.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { captureSqlitePrivateSnapshotFamily } from "./sqlite-private-snapshot-fork.js";
import type {
  PreparedSqliteReadOnlyLocation,
  RetainedPreparedSqliteReadOnlyLocation,
  RetainedSqliteSnapshotPreparation,
  SqlitePrivateSnapshotFamily,
} from "./sqlite-readonly-location.types.js";
import { assertDatabaseFileIdentity, type DatabaseFileIdentity } from "./sqlite-worker-identity.js";

// Timestamps must clear the filesystem's clock, so a later write always changes the
// fingerprint this image was captured against. Only a whole-second timestamp can come
// from a clock as coarse as FAT's two seconds; any other clock moves within a tick.
const COARSE_CLOCK_QUIESCENT_MS = 2_000;
const FINE_CLOCK_QUIESCENT_MS = 50;

export type SqliteSnapshotSource = { fingerprint: string; main: BigIntStats };
type SqliteSnapshotLease = PreparedSqliteReadOnlyLocation & RetainedPreparedSqliteReadOnlyLocation;
type SqliteSnapshotLeaseBase = Pick<
  PreparedSqliteReadOnlyLocation,
  "location" | "cleanupRoot" | "privateFamily"
>;
type ReusableImage = SqliteSnapshotSource & {
  /** A live-backup image holds the same rows, not the source's exact artifacts. */
  logicalOnly: boolean;
  location: string;
  cleanupRoot?: string;
  privateFamily?: SqlitePrivateSnapshotFamily;
  leases: number;
  retired: boolean;
  retire: () => unknown;
};

const images = resolveGlobalSingleton(
  Symbol.for("openclaw.sqliteReusableSnapshots"),
  () => new Map<string, ReusableImage>(),
);
const scopes = resolveGlobalSingleton(Symbol.for("openclaw.sqliteReusableSnapshotScopes"), () => ({
  depth: 0,
  retiring: new Set<Promise<unknown>>(),
}));

/**
 * Doctor and update processes read far more often than they commit. An image holds its
 * disk space until retired, so reuse exists only inside this scope, never in a long-lived
 * Gateway. Only producers that leave no child behind seed it: a retained child would keep
 * the process group unsettled for as long as the image lived.
 */
export async function withSqliteSnapshotReuse<T>(operation: () => Promise<T>): Promise<T> {
  scopes.depth += 1;
  try {
    return await operation();
  } finally {
    scopes.depth -= 1;
    if (scopes.depth === 0) {
      for (const [key, image] of images) {
        retire(key, image);
      }
      await Promise.allSettled(scopes.retiring);
    }
  }
}

export function isSqliteSnapshotReuseActive(): boolean {
  return scopes.depth > 0;
}

function completed<T>(value: T): RetainedOperation<T> {
  const retained = createRetainedOperation<T>(() => {});
  retained.resolve(value);
  return retained.operation;
}

/**
 * Stat only: closing even a raw descriptor here could release this process's SQLite
 * locks. Root SQLite fchowns the WAL on every open, so only the main file keeps ctime,
 * and an empty WAL holds no frames, so readers creating or removing one change no bytes.
 */
function readSource(
  canonicalPath: string,
): (SqliteSnapshotSource & { newestMs: number; quiescentMs: number }) | undefined {
  try {
    const main = fs.statSync(canonicalPath, { bigint: true, throwIfNoEntry: false });
    if (!main?.isFile() || fs.statSync(`${canonicalPath}-journal`, { throwIfNoEntry: false })) {
      return undefined;
    }
    const wal = fs.statSync(`${canonicalPath}-wal`, { bigint: true, throwIfNoEntry: false });
    const frames = wal && wal.size > 0n ? wal : undefined;
    return {
      fingerprint: [
        `${main.dev}:${main.ino}:${main.size}:${main.mtimeNs}:${main.ctimeNs}`,
        frames ? `${frames.dev}:${frames.ino}:${frames.size}:${frames.mtimeNs}` : "none",
      ].join("|"),
      main,
      newestMs: Math.max(Number(main.mtimeMs), Number(frames?.mtimeMs ?? 0)),
      quiescentMs: [main, frames].some((stat) => stat && stat.mtimeNs % 1_000_000_000n === 0n)
        ? COARSE_CLOCK_QUIESCENT_MS
        : FINE_CLOCK_QUIESCENT_MS,
    };
  } catch {
    // Reuse is only an optimization; the snapshot producer reports the real failure.
    return undefined;
  }
}

/** Sidecars live beside the real file, so an alias must not hide its WAL commits. */
function canonicalKey(pathname: string): string | undefined {
  try {
    return fs.realpathSync.native(pathname);
  } catch {
    return undefined;
  }
}

function retire(key: string, image: ReusableImage): void {
  if (images.get(key) === image) {
    images.delete(key);
  }
  image.retired = true;
  if (image.leases === 0) {
    settleRetirement(image.retire);
  }
}

function settleRetirement(retireImage: () => unknown): void {
  // Start now: the next copy should not count the outgoing image against free space.
  const retiring = new Promise((resolve) => {
    resolve(retireImage());
  })
    .catch(reportRetirementFailure)
    .finally(() => scopes.retiring.delete(retiring));
  scopes.retiring.add(retiring);
}

function reportRetirementFailure(error: unknown): void {
  // The cleanup registry keeps failed removals for the exit retry and the Gateway sweep.
  getChildLogger({ subsystem: "infra/sqlite-snapshot" }).warn(
    { error: String(error) },
    "Retiring a reusable SQLite snapshot failed.",
  );
}

function lend(key: string, image: ReusableImage): SqliteSnapshotLease {
  image.leases += 1;
  let released = false;
  const release = () => {
    if (released) {
      return true;
    }
    released = true;
    image.leases -= 1;
    if (image.leases === 0 && image.retired) {
      retire(key, image);
    }
    return true;
  };
  return {
    location: image.location,
    cleanupRoot: image.cleanupRoot,
    privateFamily: image.privateFamily,
    cleanup: release,
    cleanupAsync: async () => release(),
    startCleanup: () => completed(release()),
  };
}

/**
 * Lend the retained image only while the source is unchanged since before its copy
 * began. Callers must read it without writing; this is what keeps one update from
 * copying the whole database for every schema, lease, or single-row read.
 */
export function leaseReusableSqliteSnapshot(
  pathname: string,
  expectedIdentity?: DatabaseFileIdentity,
  options: { logicalReader?: true } = {},
): SqliteSnapshotLease | undefined {
  const key = canonicalKey(pathname);
  const image = key ? images.get(key) : undefined;
  if (!key || !image) {
    return undefined;
  }
  if (readSource(key)?.fingerprint !== image.fingerprint || !fs.existsSync(image.location)) {
    retire(key, image);
    return undefined;
  }
  if (image.logicalOnly && !options.logicalReader) {
    return undefined;
  }
  if (expectedIdentity) {
    try {
      assertDatabaseFileIdentity(image.main, expectedIdentity);
    } catch {
      // The producer owns the refusal for a caller pinned to another identity.
      return undefined;
    }
  }
  return lend(key, image);
}

/** Observe before copying; a source written within its clock's quantum is never retained. */
export function captureReusableSqliteSource(pathname: string): SqliteSnapshotSource | undefined {
  const key = scopes.depth > 0 ? canonicalKey(pathname) : undefined;
  const source = key ? readSource(key) : undefined;
  return source && Date.now() - source.newestMs >= source.quiescentMs ? source : undefined;
}

/** Borrowers may fork this image, so its family is bound before any of them can read it. */
export function captureFamily(
  prepared: Pick<PreparedSqliteReadOnlyLocation, "location" | "cleanupRoot">,
) {
  try {
    return captureSqlitePrivateSnapshotFamily(
      prepared.location,
      prepared.cleanupRoot ?? path.dirname(prepared.location),
    );
  } catch {
    // Without a family, a borrower that wanted to fork reports no forkable bytes.
    return undefined;
  }
}

const capturedSources = resolveGlobalSingleton(
  Symbol.for("openclaw.sqliteReusableSnapshotSources"),
  () => new Map<string, SqliteSnapshotSource>(),
);

/** A producer binds its image to its own observation; joined waiters may have seen a later one. */
export function bindReusableSqliteSource(
  location: string,
  source: SqliteSnapshotSource | undefined,
): void {
  if (source) {
    capturedSources.set(location, source);
  }
}

/** Publish a single-flight image under its producer's observation, or return it unchanged. */
export function publishBoundReusableSqliteSnapshot<T extends SqliteSnapshotLeaseBase>(
  pathname: string,
  prepared: T,
  retireImage: () => unknown,
): T | SqliteSnapshotLease {
  const key = canonicalKey(pathname) ?? path.resolve(pathname);
  const existing = images.get(key);
  const source =
    capturedSources.get(prepared.location) ??
    (existing?.location === prepared.location ? existing : undefined);
  capturedSources.delete(prepared.location);
  return source ? publishReusableSqliteSnapshot(pathname, source, prepared, retireImage) : prepared;
}

/** Take custody of a prepared image; `retire` discharges it after the last lease leaves. */
export function publishReusableSqliteSnapshot(
  pathname: string,
  source: SqliteSnapshotSource,
  prepared: SqliteSnapshotLeaseBase,
  retireImage: () => unknown,
  options: { logicalOnly?: true } = {},
): SqliteSnapshotLease {
  const key = canonicalKey(pathname) ?? path.resolve(pathname);
  const existing = images.get(key);
  if (existing?.location === prepared.location && existing.fingerprint === source.fingerprint) {
    // A joined single flight hands every waiter a lease on the same image.
    settleRetirement(retireImage);
    return lend(key, existing);
  }
  if (existing) {
    retire(key, existing);
  }
  const image: ReusableImage = {
    ...source,
    logicalOnly: options.logicalOnly === true,
    location: prepared.location,
    cleanupRoot: prepared.cleanupRoot,
    privateFamily: prepared.privateFamily ?? captureFamily(prepared),
    leases: 0,
    retired: false,
    retire: retireImage,
  };
  images.set(key, image);
  return lend(key, image);
}

/** A lease already owns no producer, so closing it only returns the borrowed image. */
export function createLeasedSqliteSnapshotPreparation(
  lease: SqliteSnapshotLease,
): RetainedSqliteSnapshotPreparation {
  return {
    ...completed<RetainedPreparedSqliteReadOnlyLocation>(lease),
    startClose: () => mapRetainedOperation(lease.startCleanup(), () => undefined),
  };
}
