import fs from "node:fs";
import path from "node:path";
import JSON5 from "json5";
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

function assertValidCronJobIds(jobs: unknown[], storePath: string, phase: "load" | "save") {
  const seen = new Set<string>();
  for (let i = 0; i < jobs.length; i += 1) {
    const raw = jobs[i];
    const record =
      raw && typeof raw === "object" && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : null;
    const id = typeof record?.id === "string" ? record.id.trim() : "";
    if (!id) {
      throw new Error(
        `Invalid cron store at ${storePath}: job index ${i} is missing a non-empty id (${phase})`,
      );
    }
    if (seen.has(id)) {
      throw new Error(`Invalid cron store at ${storePath}: duplicate job id "${id}" (${phase})`);
    }
    seen.add(id);
  }
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
    assertValidCronJobIds(jobs, storePath, "load");
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
  assertValidCronJobIds(store.jobs as unknown[], storePath, "save");
  await fs.promises.mkdir(path.dirname(storePath), { recursive: true });
  const { randomBytes } = await import("node:crypto");
  const tmp = `${storePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  const json = JSON.stringify(store, null, 2);
  await fs.promises.writeFile(tmp, json, "utf-8");
  await fs.promises.rename(tmp, storePath);
  try {
    await fs.promises.copyFile(storePath, `${storePath}.bak`);
  } catch {
    // best-effort
  }
}
