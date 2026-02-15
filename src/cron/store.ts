import JSON5 from "json5";
import fs from "node:fs";
import path from "node:path";
import type { CronStoreFile } from "./types.js";
import { expandHomePrefix } from "../infra/home-dir.js";
import { CONFIG_DIR } from "../utils.js";

export const DEFAULT_CRON_DIR = path.join(CONFIG_DIR, "cron");
export const DEFAULT_CRON_STORE_PATH = path.join(DEFAULT_CRON_DIR, "jobs.json");
const ATOMIC_RENAME_RETRY_CODES = new Set(["EBUSY", "EPERM", "ENOTEMPTY"]);
const ATOMIC_RENAME_RETRY_DELAYS_MS = [20, 50, 100, 200];

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
    return {
      version: 1,
      jobs: jobs.filter(Boolean) as never as CronStoreFile["jobs"],
    };
  } catch (err) {
    if ((err as { code?: unknown })?.code === "ENOENT") {
      return { version: 1, jobs: [] };
    }
    throw err;
  }
}

export async function saveCronStore(storePath: string, store: CronStoreFile) {
  await fs.promises.mkdir(path.dirname(storePath), { recursive: true });
  const tmp = `${storePath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  const json = JSON.stringify(store, null, 2);
  try {
    await fs.promises.writeFile(tmp, json, "utf-8");
    await renameWithRetry(tmp, storePath);
    try {
      await fs.promises.copyFile(storePath, `${storePath}.bak`);
    } catch {
      // best-effort
    }
  } finally {
    try {
      await fs.promises.unlink(tmp);
    } catch {
      // best-effort cleanup when rename succeeded or temp file vanished.
    }
  }
}

async function renameWithRetry(from: string, to: string) {
  let attempt = 0;
  // Retry transient Windows file-lock races around atomic rename.
  for (;;) {
    try {
      await fs.promises.rename(from, to);
      return;
    } catch (err) {
      const code =
        err && typeof err === "object" && "code" in err ? String(err.code) : undefined;
      if (!code || !ATOMIC_RENAME_RETRY_CODES.has(code) || attempt >= ATOMIC_RENAME_RETRY_DELAYS_MS.length) {
        throw err;
      }
      const delayMs = ATOMIC_RENAME_RETRY_DELAYS_MS[attempt]!;
      attempt += 1;
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
  }
}
