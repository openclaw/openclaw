import fs from "node:fs";
import path from "node:path";
import { ensureDir } from "../utils.js";
import { lockPathForJob } from "./paths.js";

export type JobLockHandle = {
  lockPath: string;
  release: () => Promise<void>;
};

export class JobLockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobLockedError";
  }
}

export async function acquireJobLock(jobId: string): Promise<JobLockHandle> {
  const lockPath = lockPathForJob(jobId);
  await ensureDir(path.dirname(lockPath));

  try {
    const fd = await fs.promises.open(lockPath, "wx");
    await fd.writeFile(
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }) + "\n",
      "utf-8",
    );

    const release = async () => {
      try {
        await fd.close();
      } catch {
        // ignore
      }
      try {
        await fs.promises.unlink(lockPath);
      } catch {
        // ignore
      }
    };

    return { lockPath, release };
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "EEXIST") {
      throw new JobLockedError(`job ${jobId} is already running (lock: ${lockPath})`);
    }
    throw err instanceof Error ? err : new Error(String(err));
  }
}
