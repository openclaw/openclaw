import type { Command } from "commander";
import { usageCommand } from "../../commands/usage.js";
import { defaultRuntime } from "../../runtime.js";
import { formatDocsLink } from "../../terminal/links.js";
import { theme } from "../../terminal/theme.js";
import { runCommandWithRuntime } from "../cli-utils.js";
import { formatHelpExamples } from "../help-format.js";

export function registerUsageCommand(program: Command) {
  program
    .command("usage")
    .description("Show token and cost usage for agent sessions")
    .option("--today", "Show usage for today (default)", false)
    .option("--week", "Show usage for the last 7 days", false)
    .option("--month", "Show usage for the last 30 days", false)
    .option("--by-source", "Break down usage by source (cron vs direct)", false)
    .option("--agent <id>", "Filter usage to a specific agent ID")
    .option("--json", "Output JSON", false)
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/usage", "docs.openclaw.ai/cli/usage")}\n` +
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          ["openclaw usage", "Show token and cost usage for today."],
          ["openclaw usage --week", "Show usage for the last 7 days."],
          [
            "openclaw usage --month --by-source",
            "Show last 30 days broken down by cron vs direct.",
          ],
          ["openclaw usage --agent my-agent --json", "Filter to a specific agent and emit JSON."],
        ])}`,
    )
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await usageCommand(
          {
            today: Boolean(opts.today),
            week: Boolean(opts.week),
            month: Boolean(opts.month),
            bySource: Boolean(opts.bySource),
            json: Boolean(opts.json),
            agent: opts.agent as string | undefined,
          },
          defaultRuntime,
        );
      });
    });
}
