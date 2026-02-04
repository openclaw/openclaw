import type { Command } from "commander";
import { meridiaDoctorCommand, meridiaStatusCommand } from "../commands/meridia.js";
import { defaultRuntime } from "../runtime.js";
import { theme } from "../terminal/theme.js";
import { runCommandWithRuntime } from "./cli-utils.js";
import { formatHelpExamples } from "./help-format.js";

export function registerMeridiaCli(program: Command) {
  program
    .command("status")
    .description("Show Meridia capture stats from local trace files")
    .option("--json", "Output JSON instead of text", false)
    .option("--since <duration>", "Lookback window (e.g., 30m, 6h, 7d)", "24h")
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          ["openclaw meridia status", "Show last 24h capture stats."],
          ["openclaw meridia status --since 6h", "Show last 6 hours."],
          ["openclaw meridia status --json", "Machine-readable output."],
        ])}`,
    )
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await meridiaStatusCommand(
          {
            json: Boolean(opts.json),
            since: opts.since as string | undefined,
          },
          defaultRuntime,
        );
      });
    });

  program
    .command("doctor")
    .description("Check Meridia capture prerequisites (Google auth, hook config, model id)")
    .option("--json", "Output JSON instead of text", false)
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          ["openclaw meridia doctor", "Check auth + hook config."],
          ["openclaw meridia doctor --json", "Machine-readable output."],
        ])}`,
    )
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await meridiaDoctorCommand(
          {
            json: Boolean(opts.json),
          },
          defaultRuntime,
        );
      });
    });
}
