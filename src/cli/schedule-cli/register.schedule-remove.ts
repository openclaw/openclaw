import type { Command } from "commander";
import { removeJob } from "../../schedule/store.js";
import { theme } from "../../terminal/theme.js";

export function registerScheduleRemoveCommand(schedule: Command) {
  schedule
    .command("remove")
    .description("Remove a scheduled job")
    .argument("<id>", "Job id")
    .action(async (id: string) => {
      const res = await removeJob(id);
      if (!res.removed) {
        process.stdout.write(`${theme.muted(`job ${id} not found`)}\n`);
        process.exitCode = 1;
        return;
      }
      process.stdout.write(`${theme.success("Removed")} job ${theme.bold(id)}\n`);
    });
}
