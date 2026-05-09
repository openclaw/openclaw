import fs from "node:fs";
import { parseJsonWithJson5Fallback } from "../utils/parse-json-compat.js";
import {
  extractCronStateFileForMigration,
  type CronStateFile,
  type CronStateFileEntry,
  writeCronJobRuntimeStateForMigration,
  writeCronJobsForMigration,
} from "./store.js";
import type { CronStoreFile } from "./types.js";

function resolveStatePath(storePath: string): string {
  if (storePath.endsWith(".json")) {
    return storePath.replace(/\.json$/, "-state.json");
  }
  return `${storePath}-state.json`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeCronStateFile(value: unknown): CronStateFile | null {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.jobs)) {
    return null;
  }
  const jobs: Record<string, CronStateFileEntry> = {};
  for (const [jobId, entry] of Object.entries(value.jobs)) {
    if (!isRecord(entry)) {
      continue;
    }
    const normalized: CronStateFileEntry = {};
    if (typeof entry.updatedAtMs === "number" && Number.isFinite(entry.updatedAtMs)) {
      normalized.updatedAtMs = entry.updatedAtMs;
    }
    if (typeof entry.scheduleIdentity === "string") {
      normalized.scheduleIdentity = entry.scheduleIdentity;
    }
    if (isRecord(entry.state)) {
      normalized.state = entry.state;
    }
    jobs[jobId] = normalized;
  }
  return { version: 1, jobs };
}

export function legacyCronStoreFileExists(storePath: string): boolean {
  try {
    return fs.existsSync(storePath);
  } catch {
    return false;
  }
}

export function legacyCronStateFileExists(storePath: string): boolean {
  try {
    return fs.existsSync(resolveStatePath(storePath));
  } catch {
    return false;
  }
}

async function loadStateFile(statePath: string): Promise<CronStateFile | null> {
  let raw: string;
  try {
    raw = await fs.promises.readFile(statePath, "utf-8");
  } catch (err) {
    if ((err as { code?: unknown })?.code === "ENOENT") {
      return null;
    }
    throw new Error(`Failed to read cron state at ${statePath}: ${String(err)}`, {
      cause: err,
    });
  }

  try {
    const parsed = parseJsonWithJson5Fallback(raw);
    return normalizeCronStateFile(parsed);
  } catch {
    // Best-effort: if state file is corrupt, treat as absent.
    return null;
  }
}

export async function loadLegacyCronStoreForMigration(
  storePath: string,
): Promise<CronStoreFile | null> {
  let raw: string;
  try {
    raw = await fs.promises.readFile(storePath, "utf-8");
  } catch (err) {
    if ((err as { code?: unknown })?.code === "ENOENT") {
      return null;
    }
    throw new Error(`Failed to read cron store at ${storePath}: ${String(err)}`, {
      cause: err,
    });
  }
  let parsed: unknown;
  try {
    parsed = parseJsonWithJson5Fallback(raw);
  } catch (err) {
    throw new Error(`Failed to parse cron store at ${storePath}: ${String(err)}`, {
      cause: err,
    });
  }
  const parsedRecord = isRecord(parsed) ? parsed : {};
  const jobs = Array.isArray(parsedRecord.jobs) ? (parsedRecord.jobs as never[]) : [];
  return {
    version: 1,
    jobs: jobs.filter(Boolean) as never as CronStoreFile["jobs"],
  };
}

export async function importLegacyCronStateFileToSqlite(storePath: string): Promise<{
  imported: boolean;
  importedJobs: number;
  removedPath?: string;
}> {
  const statePath = resolveStatePath(storePath);
  const stateFile = await loadStateFile(statePath);
  if (!stateFile) {
    return { imported: false, importedJobs: 0 };
  }
  const importedJobs = writeCronJobRuntimeStateForMigration(storePath, stateFile);
  try {
    await fs.promises.rm(statePath, { force: true });
  } catch {
    // Import already succeeded; a later doctor run can remove the stale sidecar.
  }
  return {
    imported: true,
    importedJobs,
    removedPath: statePath,
  };
}

export async function importLegacyCronStoreToSqlite(storePath: string): Promise<{
  imported: boolean;
  importedJobs: number;
  removedPath?: string;
}> {
  const store = await loadLegacyCronStoreForMigration(storePath);
  if (!store) {
    return { imported: false, importedJobs: 0 };
  }
  const stateFile =
    (await loadStateFile(resolveStatePath(storePath))) ?? extractCronStateFileForMigration(store);
  writeCronJobsForMigration(storePath, store);
  writeCronJobRuntimeStateForMigration(storePath, stateFile);
  try {
    await fs.promises.rm(storePath, { force: true });
  } catch {
    // Import already succeeded; doctor can remove the stale source on the next pass.
  }
  return {
    imported: true,
    importedJobs: store.jobs.length,
    removedPath: storePath,
  };
}
