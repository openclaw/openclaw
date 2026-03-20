import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import JSON5 from "json5";
import { expandHomePrefix } from "../infra/home-dir.js";
import { CONFIG_DIR } from "../utils.js";
import type { CronJob, CronStoreFile } from "./types.js";

export const DEFAULT_CRON_DIR = path.join(CONFIG_DIR, "cron");
export const DEFAULT_CRON_STORE_PATH = path.join(DEFAULT_CRON_DIR, "jobs.json");
/** Directory-based store: one JSON file per job */
export const DEFAULT_CRON_JOBS_DIR = path.join(DEFAULT_CRON_DIR, "jobs");
const serializedStoreCache = new Map<string, string>();

export function resolveCronStorePath(storePath?: string) {
  if (storePath?.trim()) {
    const raw = storePath.trim();
    if (raw.startsWith("~")) {
      return path.resolve(expandHomePrefix(raw));
    }
    return path.resolve(raw);
  }
  return DEFAULT_CRON_STORE_PATH;
}

export async function loadCronStore(storePath: string): Promise<CronStoreFile> {
  try {
    const raw = await fs.promises.readFile(storePath, "utf-8");
    let parsed: unknown;
    try {
      parsed = JSON5.parse(raw);
    } catch (err) {
      throw new Error(`Failed to parse cron store at ${storePath}: ${String(err)}`, {
        cause: err,
      });
    }
    const parsedRecord =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    const jobs = Array.isArray(parsedRecord.jobs) ? (parsedRecord.jobs as never[]) : [];
    const store = {
      version: 1 as const,
      jobs: jobs.filter(Boolean) as never as CronStoreFile["jobs"],
    };
    serializedStoreCache.set(storePath, JSON.stringify(store, null, 2));
    return store;
  } catch (err) {
    if ((err as { code?: unknown })?.code === "ENOENT") {
      serializedStoreCache.delete(storePath);
      return { version: 1, jobs: [] };
    }
    throw err;
  }
}

type SaveCronStoreOptions = {
  skipBackup?: boolean;
};

async function setSecureFileMode(filePath: string): Promise<void> {
  await fs.promises.chmod(filePath, 0o600).catch(() => undefined);
}

export async function saveCronStore(
  storePath: string,
  store: CronStoreFile,
  opts?: SaveCronStoreOptions,
) {
  const storeDir = path.dirname(storePath);
  await fs.promises.mkdir(storeDir, { recursive: true, mode: 0o700 });
  await fs.promises.chmod(storeDir, 0o700).catch(() => undefined);
  const json = JSON.stringify(store, null, 2);
  const cached = serializedStoreCache.get(storePath);
  if (cached === json) {
    return;
  }

  let previous: string | null = cached ?? null;
  if (previous === null) {
    try {
      previous = await fs.promises.readFile(storePath, "utf-8");
    } catch (err) {
      if ((err as { code?: unknown }).code !== "ENOENT") {
        throw err;
      }
    }
  }
  if (previous === json) {
    serializedStoreCache.set(storePath, json);
    return;
  }
  const tmp = `${storePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  await fs.promises.writeFile(tmp, json, { encoding: "utf-8", mode: 0o600 });
  await setSecureFileMode(tmp);
  if (previous !== null && !opts?.skipBackup) {
    try {
      const backupPath = `${storePath}.bak`;
      await fs.promises.copyFile(storePath, backupPath);
      await setSecureFileMode(backupPath);
    } catch {
      // best-effort
    }
  }
  await renameWithRetry(tmp, storePath);
  await setSecureFileMode(storePath);
  serializedStoreCache.set(storePath, json);
}

const RENAME_MAX_RETRIES = 3;
const RENAME_BASE_DELAY_MS = 50;

async function renameWithRetry(src: string, dest: string): Promise<void> {
  for (let attempt = 0; attempt <= RENAME_MAX_RETRIES; attempt++) {
    try {
      await fs.promises.rename(src, dest);
      return;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "EBUSY" && attempt < RENAME_MAX_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, RENAME_BASE_DELAY_MS * 2 ** attempt));
        continue;
      }
      // Windows doesn't reliably support atomic replace via rename when dest exists.
      if (code === "EPERM" || code === "EEXIST") {
        await fs.promises.copyFile(src, dest);
        await fs.promises.unlink(src).catch(() => {});
        return;
      }
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Directory-based store (one file per job)
// ---------------------------------------------------------------------------

// Order matters: longest prefix first so "_disabled." is matched before "_"
const DISABLED_PREFIXES = ["_disabled.", "disabled.", "_"];

/**
 * Slugify a job name or id for use as a filename (no extension).
 * Falls back to the raw id when slugification produces an empty string.
 */
export function slugifyCronJobName(nameOrId: string): string {
  const slug = nameOrId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || nameOrId;
}

/**
 * Derive job id from a filename (strip extension and disabled prefix).
 * e.g. "_disabled.seo-report.json" → "seo-report"
 */
export function jobIdFromFilename(filename: string): string {
  let base = path.basename(filename, ".json");
  for (const prefix of DISABLED_PREFIXES) {
    if (base.startsWith(prefix)) {
      base = base.slice(prefix.length);
      break;
    }
  }
  return base;
}

/**
 * Returns true when a filename indicates the job should be disabled.
 */
export function isDisabledFilename(filename: string): boolean {
  const base = path.basename(filename);
  return DISABLED_PREFIXES.some((p) => base.startsWith(p));
}

/**
 * Check whether the directory-based store is active for a given cron dir.
 * It is active when `<cronDir>/jobs/` exists and is a directory.
 */
export async function hasCronJobsDir(cronDir: string): Promise<boolean> {
  try {
    const stat = await fs.promises.stat(path.join(cronDir, "jobs"));
    return stat.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Load all jobs from a `jobs/` directory.
 * Each `.json` file in the directory is one job.
 * Files prefixed with `_` or `disabled.` are loaded with `enabled: false`.
 * The `id` field is inferred from the filename when absent in the file.
 */
export async function loadCronStoreDir(cronDir: string): Promise<CronStoreFile> {
  const jobsDir = path.join(cronDir, "jobs");
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(jobsDir, { withFileTypes: true });
  } catch (err) {
    if ((err as { code?: unknown })?.code === "ENOENT") {
      return { version: 1, jobs: [] };
    }
    throw err;
  }

  const jobs: CronJob[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const filePath = path.join(jobsDir, entry.name);
    let raw: string;
    try {
      raw = await fs.promises.readFile(filePath, "utf-8");
    } catch {
      continue; // skip unreadable files
    }
    let parsed: unknown;
    try {
      parsed = JSON5.parse(raw);
    } catch (err) {
      throw new Error(`Failed to parse cron job file ${filePath}: ${String(err)}`, { cause: err });
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const job = parsed as Record<string, unknown>;
    // Infer id from filename when absent
    if (!job.id) {
      job.id = jobIdFromFilename(entry.name);
    }
    // Apply disabled prefix rule
    if (isDisabledFilename(entry.name)) {
      job.enabled = false;
    }
    jobs.push(job as never as CronJob);
  }
  return { version: 1, jobs };
}

/**
 * Write a single job to `<cronDir>/jobs/<slug>.json`.
 * Creates the directory if needed.
 */
export async function saveCronJobFile(cronDir: string, job: CronJob): Promise<void> {
  const jobsDir = path.join(cronDir, "jobs");
  await fs.promises.mkdir(jobsDir, { recursive: true, mode: 0o700 });
  const slug = slugifyCronJobName(job.name ?? job.id);
  const filePath = path.join(jobsDir, `${slug}.json`);
  const json = JSON.stringify(job, null, 2);
  const tmp = `${filePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  await fs.promises.writeFile(tmp, json, { encoding: "utf-8", mode: 0o600 });
  await fs.promises.chmod(tmp, 0o600).catch(() => undefined);
  await renameWithRetry(tmp, filePath);
  await fs.promises.chmod(filePath, 0o600).catch(() => undefined);
}

/**
 * Remove a single job file from `<cronDir>/jobs/`.
 * Matches by job id (inferred from filename) or exact filename slug.
 * No-ops when the file does not exist.
 */
export async function removeCronJobFile(cronDir: string, jobId: string): Promise<boolean> {
  const jobsDir = path.join(cronDir, "jobs");
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(jobsDir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    if (jobIdFromFilename(entry.name) === jobId) {
      await fs.promises.unlink(path.join(jobsDir, entry.name)).catch(() => undefined);
      return true;
    }
  }
  return false;
}

/**
 * Migrate `jobs.json` → `jobs/*.json` (one file per job).
 * Existing `jobs/` directory is created if needed.
 * Returns the number of jobs migrated.
 */
export async function migrateCronStoreToDir(
  storePath: string,
  cronDir: string,
): Promise<{ migrated: number; skipped: number }> {
  const store = await loadCronStore(storePath);
  let migrated = 0;
  let skipped = 0;
  for (const job of store.jobs) {
    try {
      await saveCronJobFile(cronDir, job);
      migrated++;
    } catch {
      skipped++;
    }
  }
  return { migrated, skipped };
}
