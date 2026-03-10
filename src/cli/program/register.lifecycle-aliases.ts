import type { Command } from "commander";
import { theme } from "../../terminal/theme.js";
import { runDaemonRestart, runDaemonStart, runDaemonStop } from "../daemon-cli/runners.js";
import { formatHelpExamples } from "../help-format.js";

export function registerLifecycleAliasCommands(program: Command) {
  program
    .command("restart")
    .description("Restart the Gateway service (alias for `openclaw gateway restart`)")
    .option("--json", "Output JSON", false)
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          ["openclaw restart", "Restart the gateway service."],
          ["openclaw restart --json", "Machine-readable output."],
        ])}`,
    )
    .action(async (opts) => {
      await runDaemonRestart({ json: Boolean(opts.json) });
    });

  program
    .command("start")
    .description("Start the Gateway service (alias for `openclaw gateway start`)")
    .option("--json", "Output JSON", false)
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          ["openclaw start", "Start the gateway service."],
          ["openclaw start --json", "Machine-readable output."],
        ])}`,
    )
    .action(async (opts) => {
      await runDaemonStart({ json: Boolean(opts.json) });
    });

  program
    .command("stop")
    .description("Stop the Gateway service (alias for `openclaw gateway stop`)")
    .option("--json", "Output JSON", false)
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          ["openclaw stop", "Stop the gateway service."],
          ["openclaw stop --json", "Machine-readable output."],
        ])}`,
    )
    .action(async (opts) => {
      await runDaemonStop({ json: Boolean(opts.json) });
    });
}
