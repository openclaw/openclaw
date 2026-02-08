import type { Command } from "commander";
import { acquireJobLock, JobLockedError } from "../../schedule/lock.js";
import { runJobNow } from "../../schedule/run.js";
import { getJob } from "../../schedule/store.js";
import { theme } from "../../terminal/theme.js";

export function registerScheduleRunNowCommand(schedule: Command) {
  schedule
    .command("run-now")
    .description("Run a scheduled job immediately")
    .argument("<id>", "Job id")
    .option("--json", "Output JSON", false)
    .action(async (id: string, opts: { json?: boolean }) => {
      const job = await getJob(id);
      if (!job) {
        process.stderr.write(`${theme.error("error:")} job ${id} not found\n`);
        process.exitCode = 1;
        return;
      }

      let lock: Awaited<ReturnType<typeof acquireJobLock>> | null = null;
      try {
        lock = await acquireJobLock(id);
        const record = await runJobNow(job, { inheritStdio: !opts.json });
        if (opts.json) {
          process.stdout.write(`${JSON.stringify(record)}\n`);
        }
        if (record.error) {
          process.stderr.write(`${theme.error("error:")} ${record.error}\n`);
          process.exitCode = 1;
          return;
        }
        if ((record.exitCode ?? 0) !== 0) {
          process.exitCode = record.exitCode ?? 1;
        }
      } catch (err) {
        if (err instanceof JobLockedError) {
          process.stderr.write(`${theme.error("error:")} ${err.message}\n`);
          process.exitCode = 2;
          return;
        }
        throw err;
      } finally {
        await lock?.release();
      }
    });
}
