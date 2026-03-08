import path from "node:path";
import { CONFIG_DIR } from "../utils.js";

export const SCHEDULE_PATH = path.join(CONFIG_DIR, "schedule.json");
export const SCHEDULE_RUNS_PATH = path.join(CONFIG_DIR, "schedule-runs.jsonl");
export const SCHEDULE_LOCKS_DIR = path.join(CONFIG_DIR, "schedule-locks");

export function lockPathForJob(jobId: string): string {
  // Keep filenames predictable and avoid path traversal.
  const safe = jobId.replaceAll(/[^A-Za-z0-9_.-]/g, "_");
  return path.join(SCHEDULE_LOCKS_DIR, `${safe}.lock`);
}
