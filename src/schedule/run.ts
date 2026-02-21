import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ScheduleJob, ScheduleRunRecord } from "./types.js";
import { ensureDir } from "../utils.js";
import { SCHEDULE_RUNS_PATH } from "./paths.js";

export async function appendRunRecord(record: ScheduleRunRecord): Promise<void> {
  await ensureDir(path.dirname(SCHEDULE_RUNS_PATH));
  await fs.promises.appendFile(SCHEDULE_RUNS_PATH, `${JSON.stringify(record)}\n`, "utf-8");
}

export async function runJobNow(
  job: ScheduleJob,
  opts?: { inheritStdio?: boolean },
): Promise<ScheduleRunRecord> {
  const started = Date.now();
  const ts = new Date().toISOString();

  let exitCode: number | null = null;
  let signal: NodeJS.Signals | null = null;
  let error: string | undefined;

  try {
    exitCode = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(job.cmd, job.args ?? [], {
        cwd: job.cwd,
        env: job.env ? { ...process.env, ...job.env } : process.env,
        stdio: opts?.inheritStdio === false ? "pipe" : "inherit",
        shell: false,
      });

      child.on("error", (err) => reject(err));
      child.on("exit", (code, sig) => {
        signal = sig;
        resolve(code);
      });
    });
  } catch (err) {
    error = err instanceof Error ? err.stack || err.message : String(err);
  }

  const durationMs = Date.now() - started;
  const record: ScheduleRunRecord = {
    ts,
    jobId: job.id,
    cmd: job.cmd,
    args: job.args ?? [],
    cwd: job.cwd,
    exitCode,
    signal,
    durationMs,
    ...(error ? { error } : {}),
  };

  await appendRunRecord(record);
  return record;
}
