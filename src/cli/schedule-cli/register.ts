import type { Command } from "commander";
import { formatDocsLink } from "../../terminal/links.js";
import { theme } from "../../terminal/theme.js";
import { registerScheduleAddCommand } from "./register.schedule-add.js";
import { registerScheduleListCommand } from "./register.schedule-list.js";
import { registerScheduleRemoveCommand } from "./register.schedule-remove.js";
import { registerScheduleRunNowCommand } from "./register.schedule-run-now.js";

export function registerScheduleCli(program: Command) {
  const schedule = program
    .command("schedule")
    .description("Local scheduler helpers (prototype)")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/schedule", "docs.openclaw.ai/cli/schedule")}\n`,
    );

  registerScheduleListCommand(schedule);
  registerScheduleAddCommand(schedule);
  registerScheduleRemoveCommand(schedule);
  registerScheduleRunNowCommand(schedule);
}
