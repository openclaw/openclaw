import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { expandHomePrefix } from "../infra/home-dir.js";
import { resolveConfigDir } from "../utils.js";
import { parseJsonWithJson5Fallback } from "../utils/parse-json-compat.js";
import type { CronStoreFile } from "./types.js";

const serializedStoreCache = new Map<string, string>();

function resolveDefaultCronDir(): string {
  return path.join(resolveConfigDir(), "cron");
}

function resolveDefaultCronStorePath(): string {
  return path.join(resolveDefaultCronDir(), "jobs.json");
}

function resolveStatePath(storePath: string): string {
  return storePath.replace(/\.json$/, "-state.json");
}

type CronStateFileEntry = {
  updatedAtMs?: number;
  state?: Record<string, unknown>;
};

type CronStateFile = {
  version: 1;
  jobs: Record<string, CronStateFileEntry>;
};

function stripRuntimeOnlyCronFields(store: CronStoreFile): unknown {
  return {
    version: store.version,
    jobs: store.jobs.map((job) => {
      const { state: _state, updatedAtMs: _updatedAtMs, ...rest } = job;
      return { ...rest, state: {} };
    }),
  };
}

function extractStateFile(store: CronStoreFile): CronStateFile {
  const jobs: Record<string, CronStateFileEntry> = {};
  for (const job of store.jobs) {
    jobs[job.id] = {
      updatedAtMs: job.updatedAtMs,
      state: job.state ?? {},
    };
  }
  return { version: 1, jobs };
}

export function resolveCronStorePath(storePath?: string) {
  if (storePath?.trim()) {
    const raw = storePath.trim();
    if (raw.startsWith("~")) {
      return path.resolve(expandHomePrefix(raw));
    }
    return path.resolve(raw);
  }
  return resolveDefaultCronStorePath();
}

async function loadStateFile(statePath: string): Promise<CronStateFile | null> {
  try {
    const raw = await fs.promises.readFile(statePath, "utf-8");
    const parsed = parseJsonWithJson5Fallback(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    if (record.version !== 1 || typeof record.jobs !== "object" || record.jobs === null) {
      return null;
    }
    return { version: 1, jobs: record.jobs as Record<string, CronStateFileEntry> };
  } catch (err) {
    if ((err as { code?: unknown })?.code === "ENOENT") {
      return null;
    }
    // Best-effort: if state file is corrupt, treat as absent.
    return null;
  }
}

function hasInlineState(jobs: Array<Record<string, unknown>>): boolean {
  return jobs.some(
    (job) =>
      job.state !== undefined &&
      typeof job.state === "object" &&
      job.state !== null &&
      Object.keys(job.state as Record<string, unknown>).length > 0,
  );
}

export async function loadCronStore(storePath: string): Promise<CronStoreFile> {
  try {
    const raw = await fs.promises.readFile(storePath, "utf-8");
    let parsed: unknown;
    try {
      parsed = parseJsonWithJson5Fallback(raw);
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

    // Load state file and merge.
    const statePath = resolveStatePath(storePath);
    const stateFile = await loadStateFile(statePath);

    if (stateFile) {
      // State file exists: merge state by job ID. Inline state in jobs.json is ignored.
      for (const job of store.jobs) {
        const entry = stateFile.jobs[job.id];
        if (entry) {
          job.updatedAtMs = entry.updatedAtMs ?? job.updatedAtMs;
          job.state = (entry.state ?? {}) as never;
        } else {
          // Job exists in config but not in state file: default to empty state.
          if (!job.state || typeof job.state !== "object") {
            job.state = {} as never;
          }
        }
      }
    } else if (!hasInlineState(jobs as unknown as Array<Record<string, unknown>>)) {
      // No state file, no inline state: fresh clone or first run.
      for (const job of store.jobs) {
        job.state = (job.state && typeof job.state === "object" ? job.state : {}) as never;
      }
    }
    // else: migration mode — no state file but jobs.json has inline state. Use as-is.

    // Ensure every job has a state object (defensive).
    for (const job of store.jobs) {
      if (!job.state || typeof job.state !== "object") {
        job.state = {} as never;
      }
    }

    const configJson = JSON.stringify(stripRuntimeOnlyCronFields(store), null, 2);
    serializedStoreCache.set(storePath, configJson);
    if (stateFile) {
      serializedStoreCache.set(`${storePath}:state`, JSON.stringify(stateFile, null, 2));
    }

    return store;
  } catch (err) {
    if ((err as { code?: unknown })?.code === "ENOENT") {
      serializedStoreCache.delete(storePath);
      serializedStoreCache.delete(`${storePath}:state`);
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

async function atomicWrite(filePath: string, content: string, dirMode = 0o700): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.promises.mkdir(dir, { recursive: true, mode: dirMode });
  await fs.promises.chmod(dir, dirMode).catch(() => undefined);
  const tmp = `${filePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  await fs.promises.writeFile(tmp, content, { encoding: "utf-8", mode: 0o600 });
  await setSecureFileMode(tmp);
  await renameWithRetry(tmp, filePath);
  await setSecureFileMode(filePath);
}

export async function saveCronStore(
  storePath: string,
  store: CronStoreFile,
  opts?: SaveCronStoreOptions,
) {
  const configJson = JSON.stringify(stripRuntimeOnlyCronFields(store), null, 2);
  const stateFile = extractStateFile(store);
  const stateJson = JSON.stringify(stateFile, null, 2);

  const statePath = resolveStatePath(storePath);
  const configCacheKey = storePath;
  const stateCacheKey = `${storePath}:state`;

  const cachedConfig = serializedStoreCache.get(configCacheKey);
  const cachedState = serializedStoreCache.get(stateCacheKey);

  const configChanged = cachedConfig !== configJson;
  const stateChanged = cachedState !== stateJson;

  if (!configChanged && !stateChanged) {
    return;
  }

  // Detect migration: state file does not exist on disk yet.
  let migrating = false;
  if (!cachedState) {
    try {
      await fs.promises.access(statePath, fs.constants.F_OK);
    } catch {
      migrating = true;
    }
  }

  // Write state file first (safer ordering for migration — see PR_DRAFT.md Atomicity).
  if (stateChanged || migrating) {
    await atomicWrite(statePath, stateJson);
    serializedStoreCache.set(stateCacheKey, stateJson);
  }

  if (configChanged || migrating) {
    // Determine backup need: only when config actually changed (not migration-only).
    const skipBackup = opts?.skipBackup === true || !configChanged;
    if (!skipBackup) {
      try {
        const backupPath = `${storePath}.bak`;
        await fs.promises.copyFile(storePath, backupPath);
        await setSecureFileMode(backupPath);
      } catch {
        // best-effort
      }
    }
    await atomicWrite(storePath, configJson);
    serializedStoreCache.set(configCacheKey, configJson);
  }
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
