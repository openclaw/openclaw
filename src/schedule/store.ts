import fs from "node:fs";
import path from "node:path";
import type { ScheduleFile, ScheduleJob } from "./types.js";
import { ensureDir } from "../utils.js";
import { SCHEDULE_PATH } from "./paths.js";

const EMPTY: ScheduleFile = { version: 1, jobs: [] };

function nowIso(): string {
  return new Date().toISOString();
}

export async function loadScheduleFile(opts?: { filePath?: string }): Promise<ScheduleFile> {
  const filePath = opts?.filePath ?? SCHEDULE_PATH;
  try {
    const raw = await fs.promises.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<ScheduleFile> | null;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.jobs)) {
      return { ...EMPTY };
    }
    return {
      version: 1,
      jobs: parsed.jobs.filter(Boolean),
    };
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") {
      return { ...EMPTY };
    }
    throw err instanceof Error ? err : new Error(String(err));
  }
}

export async function saveScheduleFile(
  data: ScheduleFile,
  opts?: { filePath?: string },
): Promise<void> {
  const filePath = opts?.filePath ?? SCHEDULE_PATH;
  await ensureDir(path.dirname(filePath));
  const next: ScheduleFile = {
    version: 1,
    jobs: data.jobs,
  };
  await fs.promises.writeFile(filePath, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
}

export async function addOrUpdateJob(
  job: Omit<ScheduleJob, "createdAt" | "updatedAt"> & {
    createdAt?: string;
    updatedAt?: string;
  },
  opts?: { filePath?: string },
): Promise<{ schedule: ScheduleFile; job: ScheduleJob; created: boolean }> {
  const schedule = await loadScheduleFile(opts);
  const ts = nowIso();
  const existingIndex = schedule.jobs.findIndex((j) => j.id === job.id);
  if (existingIndex >= 0) {
    const createdAt = schedule.jobs[existingIndex]?.createdAt ?? ts;
    const updated: ScheduleJob = {
      ...schedule.jobs[existingIndex],
      ...job,
      createdAt,
      updatedAt: ts,
    };
    schedule.jobs.splice(existingIndex, 1, updated);
    await saveScheduleFile(schedule, opts);
    return { schedule, job: updated, created: false };
  }

  const created: ScheduleJob = {
    ...job,
    args: job.args ?? [],
    createdAt: job.createdAt ?? ts,
    updatedAt: job.updatedAt ?? ts,
  };
  schedule.jobs.push(created);
  schedule.jobs.sort((a, b) => a.id.localeCompare(b.id));
  await saveScheduleFile(schedule, opts);
  return { schedule, job: created, created: true };
}

export async function removeJob(
  jobId: string,
  opts?: { filePath?: string },
): Promise<{ schedule: ScheduleFile; removed: boolean }> {
  const schedule = await loadScheduleFile(opts);
  const before = schedule.jobs.length;
  schedule.jobs = schedule.jobs.filter((j) => j.id !== jobId);
  const removed = schedule.jobs.length !== before;
  if (removed) {
    await saveScheduleFile(schedule, opts);
  }
  return { schedule, removed };
}

export async function getJob(
  jobId: string,
  opts?: { filePath?: string },
): Promise<ScheduleJob | null> {
  const schedule = await loadScheduleFile(opts);
  return schedule.jobs.find((j) => j.id === jobId) ?? null;
}
