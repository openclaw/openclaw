import path from "node:path";
import { getDatastore } from "../infra/datastore.js";
import { expandHomePrefix } from "../infra/home-dir.js";
import { CONFIG_DIR } from "../utils.js";
import type { CronStoreFile } from "./types.js";

export const DEFAULT_CRON_DIR = path.join(CONFIG_DIR, "cron");
export const DEFAULT_CRON_STORE_PATH = path.join(DEFAULT_CRON_DIR, "jobs.json");

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
  let parsed: Record<string, unknown> | null;
  try {
    parsed = getDatastore().readJson5<Record<string, unknown>>(storePath);
  } catch (err) {
    throw new Error(`Failed to parse cron store at ${storePath}: ${String(err)}`, {
      cause: err,
    });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { version: 1, jobs: [] };
  }
  const jobs = Array.isArray(parsed.jobs) ? (parsed.jobs as never[]) : [];
  return {
    version: 1,
    jobs: jobs.filter(Boolean) as never as CronStoreFile["jobs"],
  };
}

export async function saveCronStore(storePath: string, store: CronStoreFile) {
  await getDatastore().writeWithBackup(storePath, store);
}
