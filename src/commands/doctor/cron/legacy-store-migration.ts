// Legacy cron JSON/state store loader and archiver for doctor migration.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "../../../../packages/normalization-core/src/record-coerce.js";
import {
  normalizeOptionalString,
  normalizeOptionalStringifiedId,
} from "../../../../packages/normalization-core/src/string-coerce.js";
import { coerceFiniteScheduleNumber } from "../../../cron/schedule-number.js";
import { normalizeCronStaggerMs } from "../../../cron/stagger.js";
import type {
  CronConfigJobRuntimeEntry,
  LoadedCronStore,
  QuarantinedCronConfigJob,
} from "../../../cron/store.js";
import type { CronStoreFile } from "../../../cron/types.js";
import { parseJsonWithJson5Fallback } from "../../../utils/parse-json-compat.js";

const LEGACY_CRON_ARCHIVE_SUFFIX = ".migrated";
const legacyCronMigrationIds = new WeakMap<Record<string, unknown>, string>();

export function resolveLegacyCronMigrationId(job: Record<string, unknown>): string | undefined {
  return legacyCronMigrationIds.get(job);
}

function markLegacyCronMigrationIdentity(job: Record<string, unknown>, sourceIndex: number): void {
  if (normalizeOptionalStringifiedId(job.id) ?? normalizeOptionalStringifiedId(job.jobId)) {
    return;
  }
  const digest = createHash("sha256").update(JSON.stringify(job)).digest("hex");
  legacyCronMigrationIds.set(job, `cron-migrated-${sourceIndex}-${digest}`);
}

function resolveLegacyCronStatePath(storePath: string): string {
  if (storePath.endsWith(".json")) {
    return storePath.replace(/\.json$/, "-state.json");
  }
  return `${storePath}-state.json`;
}

async function legacyCronFileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw err;
  }
}

type ArchiveOutcome = { ok: true } | { ok: false; reason: string };

function formatArchiveError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isUnsupportedDirectorySyncError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "EINVAL" || code === "ENOTSUP" || code === "ENOSYS") {
    return true;
  }
  return (
    process.platform === "win32" && (code === "EISDIR" || code === "EPERM" || code === "EACCES")
  );
}

async function syncArchiveDirectory(dirPath: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(dirPath, "r");
    await handle.sync();
  } catch (err) {
    if (!isUnsupportedDirectorySyncError(err)) {
      throw err;
    }
  } finally {
    await handle?.close();
  }
}

async function copyLegacyCronFileAcrossDevices(
  filePath: string,
  initialArchivePath: string,
): Promise<ArchiveOutcome> {
  let archivePath = initialArchivePath;
  let archiveCreated = false;
  let sourceRemoved = false;
  try {
    const sourceStat = await fs.stat(filePath);
    const sourceMode = sourceStat.mode & 0o777;
    for (let index = 2; ; index += 1) {
      try {
        const archiveHandle = await fs.open(archivePath, "wx", sourceMode | 0o600);
        archiveCreated = true;
        await archiveHandle.close();
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
          throw err;
        }
        archivePath = `${filePath}${LEGACY_CRON_ARCHIVE_SUFFIX}.${index}`;
      }
    }

    // Claim the destination before copyFile so any partial output from a failed,
    // non-atomic copy is owned by this attempt and removed by the catch path.
    await fs.copyFile(filePath, archivePath);
    await fs.chmod(archivePath, sourceMode | 0o600);
    const archiveHandle = await fs.open(archivePath, "r+");
    try {
      await archiveHandle.chmod(sourceMode);
      await archiveHandle.utimes(sourceStat.atime, sourceStat.mtime);
      await archiveHandle.sync();
    } finally {
      await archiveHandle.close();
    }
    await syncArchiveDirectory(path.dirname(archivePath));
    await fs.unlink(filePath);
    sourceRemoved = true;
    await syncArchiveDirectory(path.dirname(filePath));
    return { ok: true };
  } catch (err) {
    if (sourceRemoved) {
      return {
        ok: false,
        reason: `${formatArchiveError(err)}; the durable archive is preserved at ${archivePath} because the source was already removed`,
      };
    }
    if (archiveCreated) {
      let archiveRemoved = false;
      try {
        try {
          await fs.unlink(archivePath);
        } catch (cleanupErr) {
          if ((cleanupErr as NodeJS.ErrnoException).code !== "ENOENT") {
            throw cleanupErr;
          }
        }
        archiveRemoved = true;
        await syncArchiveDirectory(path.dirname(archivePath));
      } catch (cleanupErr) {
        return {
          ok: false,
          reason: archiveRemoved
            ? `${formatArchiveError(err)}; the partial archive was removed, but cleanup directory sync failed: ${formatArchiveError(cleanupErr)}`
            : `${formatArchiveError(err)}; partial archive remains at ${archivePath} because cleanup failed: ${formatArchiveError(cleanupErr)}`,
        };
      }
    }
    return { ok: false, reason: formatArchiveError(err) };
  }
}

async function archiveLegacyCronFile(filePath: string): Promise<ArchiveOutcome> {
  let archivePath = `${filePath}${LEGACY_CRON_ARCHIVE_SUFFIX}`;
  try {
    if (!(await legacyCronFileExists(filePath))) {
      return { ok: true };
    }
    for (let index = 2; await legacyCronFileExists(archivePath); index += 1) {
      archivePath = `${filePath}${LEGACY_CRON_ARCHIVE_SUFFIX}.${index}`;
    }
  } catch (err) {
    return { ok: false, reason: formatArchiveError(err) };
  }

  try {
    await fs.rename(filePath, archivePath);
  } catch (err) {
    // A cross-device rename can occur when the configured store is a mounted file.
    // Fsync before source removal and roll back failed cleanup so retries stay idempotent.
    if ((err as { code?: unknown })?.code !== "EXDEV") {
      return { ok: false, reason: formatArchiveError(err) };
    }
    return await copyLegacyCronFileAcrossDevices(filePath, archivePath);
  }

  try {
    await syncArchiveDirectory(path.dirname(filePath));
    return { ok: true };
  } catch (err) {
    let sourceRestored = false;
    try {
      await fs.rename(archivePath, filePath);
      sourceRestored = true;
      await syncArchiveDirectory(path.dirname(filePath));
    } catch (rollbackErr) {
      return {
        ok: false,
        reason: sourceRestored
          ? `${formatArchiveError(err)}; the source was restored, but rollback directory sync failed: ${formatArchiveError(rollbackErr)}`
          : `${formatArchiveError(err)}; archive remains at ${archivePath} because restoring the source failed: ${formatArchiveError(rollbackErr)}`,
      };
    }
    return { ok: false, reason: formatArchiveError(err) };
  }
}

function parseCronStateFile(raw: string): {
  version: 1;
  jobs: Record<string, CronConfigJobRuntimeEntry>;
} | null {
  try {
    const parsed = parseJsonWithJson5Fallback(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    if (
      record.version !== 1 ||
      typeof record.jobs !== "object" ||
      record.jobs === null ||
      Array.isArray(record.jobs)
    ) {
      return null;
    }
    return {
      version: 1,
      jobs: record.jobs as Record<string, CronConfigJobRuntimeEntry>,
    };
  } catch {
    return null;
  }
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  return normalizeOptionalString(record[key]);
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  return coerceFiniteScheduleNumber(record[key]);
}

function legacySchedulePayloadFromRecord(
  schedule: Record<string, unknown>,
):
  | { kind: "at"; at: string }
  | { kind: "every"; everyMs: number; anchorMs?: number }
  | { kind: "cron"; expr: string; tz?: string; staggerMs?: number }
  | undefined {
  const rawKind = readString(schedule, "kind")?.toLowerCase();
  const expr = readString(schedule, "expr") ?? readString(schedule, "cron");
  const at = readString(schedule, "at");
  const atMs = readNumber(schedule, "atMs");
  const everyMs = readNumber(schedule, "everyMs");
  const anchorMs = readNumber(schedule, "anchorMs");
  const tz = readString(schedule, "tz");
  const staggerMs = normalizeCronStaggerMs(schedule.staggerMs);
  const kind =
    rawKind === "at" || rawKind === "every" || rawKind === "cron"
      ? rawKind
      : at || atMs !== undefined
        ? "at"
        : everyMs !== undefined
          ? "every"
          : expr
            ? "cron"
            : undefined;

  if (kind === "at") {
    return at
      ? { kind: "at", at }
      : atMs !== undefined
        ? { kind: "at", at: String(atMs) }
        : undefined;
  }
  if (kind === "every" && everyMs !== undefined) {
    return { kind: "every", everyMs, anchorMs };
  }
  if (kind === "cron" && expr) {
    return { kind: "cron", expr, tz, staggerMs };
  }
  return undefined;
}

function tryLegacyCronScheduleIdentity(job: Record<string, unknown>): string | undefined {
  const schedule =
    job.schedule && typeof job.schedule === "object" && !Array.isArray(job.schedule)
      ? legacySchedulePayloadFromRecord(job.schedule as Record<string, unknown>)
      : legacySchedulePayloadFromRecord(job);
  if (!schedule) {
    return undefined;
  }
  return JSON.stringify({
    version: 1,
    enabled: typeof job.enabled === "boolean" ? job.enabled : true,
    schedule,
  });
}

function getRawCronJobs(parsed: unknown): unknown[] {
  return Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.jobs)
      ? parsed.jobs
      : [];
}

function cloneConfigJobs(jobs: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return jobs.map((job) => structuredClone(job));
}

async function loadStateFile(
  statePath: string,
): Promise<{ version: 1; jobs: Record<string, CronConfigJobRuntimeEntry> } | null> {
  let raw: string;
  try {
    raw = await fs.readFile(statePath, "utf-8");
  } catch (err) {
    if ((err as { code?: unknown })?.code === "ENOENT") {
      return null;
    }
    throw new Error(`Failed to read cron state at ${statePath}: ${String(err)}`, {
      cause: err,
    });
  }

  return parseCronStateFile(raw);
}

function hasInlineState(jobs: Array<Record<string, unknown> | null | undefined>): boolean {
  return jobs.some(
    (job) => job != null && isRecord(job.state) && Object.keys(job.state).length > 0,
  );
}

function ensureJobStateObject(job: CronStoreFile["jobs"][number]): void {
  if (!isRecord(job.state)) {
    job.state = {} as never;
  }
}

function backfillMissingRuntimeFields(job: CronStoreFile["jobs"][number]): void {
  ensureJobStateObject(job);
  if (typeof job.updatedAtMs !== "number") {
    job.updatedAtMs = typeof job.createdAtMs === "number" ? job.createdAtMs : Date.now();
  }
}

function resolveUpdatedAtMs(job: CronStoreFile["jobs"][number], updatedAtMs: unknown): number {
  if (typeof updatedAtMs === "number" && Number.isFinite(updatedAtMs)) {
    return updatedAtMs;
  }
  if (typeof job.updatedAtMs === "number" && Number.isFinite(job.updatedAtMs)) {
    return job.updatedAtMs;
  }
  return typeof job.createdAtMs === "number" && Number.isFinite(job.createdAtMs)
    ? job.createdAtMs
    : Date.now();
}

function mergeStateFileEntry(job: CronStoreFile["jobs"][number], entry: unknown): void {
  if (!isRecord(entry)) {
    backfillMissingRuntimeFields(job);
    return;
  }
  job.updatedAtMs = resolveUpdatedAtMs(job, entry.updatedAtMs);
  job.state = isRecord(entry.state) ? (entry.state as never) : ({} as never);
  if (
    typeof entry.scheduleIdentity === "string" &&
    entry.scheduleIdentity !==
      tryLegacyCronScheduleIdentity(job as unknown as Record<string, unknown>)
  ) {
    ensureJobStateObject(job);
    job.state.nextRunAtMs = undefined;
  }
}

function resolveCronStateId(job: Record<string, unknown>): string | undefined {
  return normalizeOptionalString(job.id) ?? normalizeOptionalString(job.jobId);
}

/** Return true when legacy cron JSON or state files exist for a store path. */
export async function legacyCronStoreFilesExist(storePath: string): Promise<boolean> {
  const resolvedStorePath = path.resolve(storePath);
  return (
    (await legacyCronFileExists(resolvedStorePath)) ||
    (await legacyCronFileExists(resolveLegacyCronStatePath(resolvedStorePath)))
  );
}

export type LegacyCronArchiveResult =
  | { ok: true }
  | { ok: false; failures: Array<{ path: string; reason: string }> };

/** Archive legacy cron JSON/state files after successful migration. */
export async function archiveLegacyCronStoreForMigration(
  storePath: string,
): Promise<LegacyCronArchiveResult> {
  const resolvedStorePath = path.resolve(storePath);
  const targets = [resolvedStorePath, resolveLegacyCronStatePath(resolvedStorePath)];
  const outcomes = await Promise.all(targets.map(archiveLegacyCronFile));
  const failures = outcomes.flatMap((outcome, index) =>
    outcome.ok ? [] : [{ path: targets[index], reason: outcome.reason }],
  );
  return failures.length === 0 ? { ok: true } : { ok: false, failures };
}

/** Load legacy cron JSON/state files into the current loaded-store shape for migration. */
export async function loadLegacyCronStoreForMigration(storePath: string): Promise<LoadedCronStore> {
  const resolvedStorePath = path.resolve(storePath);
  try {
    const raw = await fs.readFile(resolvedStorePath, "utf-8");
    let parsed: unknown;
    try {
      parsed = parseJsonWithJson5Fallback(raw);
    } catch (err) {
      throw new Error(`Failed to parse cron store at ${resolvedStorePath}: ${String(err)}`, {
        cause: err,
      });
    }
    const rawJobs = getRawCronJobs(parsed);
    const configJobIndexes: number[] = [];
    const configRows: Array<Record<string, unknown>> = [];
    const configJobRuntimeEntries: CronConfigJobRuntimeEntry[] = [];
    const invalidConfigRows: QuarantinedCronConfigJob[] = [];
    for (const [index, row] of rawJobs.entries()) {
      if (isRecord(row)) {
        // The source position distinguishes identical id-less rows, while the raw digest
        // prevents an edited retry from being mistaken for the row previously imported.
        markLegacyCronMigrationIdentity(row, index);
        configJobIndexes.push(index);
        configRows.push(row);
      } else {
        invalidConfigRows.push({
          sourceIndex: index,
          reason: "non-object-row",
          raw: structuredClone(row),
        });
      }
    }
    const store: CronStoreFile = {
      version: 1,
      jobs: configRows as never as CronStoreFile["jobs"],
    };
    const jobs = store.jobs as unknown as Array<Record<string, unknown>>;
    const configJobs = cloneConfigJobs(configRows);

    const stateFile = await loadStateFile(resolveLegacyCronStatePath(resolvedStorePath));
    const hasLegacyInlineState = !stateFile && hasInlineState(jobs);

    if (stateFile) {
      for (const job of store.jobs) {
        const stateId = resolveCronStateId(job as unknown as Record<string, unknown>);
        const entry = stateId ? stateFile.jobs[stateId] : undefined;
        configJobRuntimeEntries.push(isRecord(entry) ? structuredClone(entry) : {});
        if (entry) {
          mergeStateFileEntry(job, entry);
        } else {
          backfillMissingRuntimeFields(job);
        }
      }
    } else if (!hasLegacyInlineState) {
      for (const job of store.jobs) {
        backfillMissingRuntimeFields(job);
      }
    }

    for (const job of store.jobs) {
      ensureJobStateObject(job);
    }

    return { store, configJobs, configJobIndexes, configJobRuntimeEntries, invalidConfigRows };
  } catch (err) {
    if ((err as { code?: unknown })?.code === "ENOENT") {
      return {
        store: { version: 1, jobs: [] },
        configJobs: [],
        configJobIndexes: [],
        configJobRuntimeEntries: [],
        invalidConfigRows: [],
      };
    }
    throw err;
  }
}
