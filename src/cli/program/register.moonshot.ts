/**
 * CLI registration for Moonshot (Kimi) commands.
 *
 * Registers: moltbot moonshot:smoke
 */
import type { Command } from "commander";

import { moonshotSmokeCommand } from "../../commands/moonshot-smoke.js";
import { defaultRuntime } from "../../runtime.js";
import { theme } from "../../terminal/theme.js";
import { runCommandWithRuntime } from "../cli-utils.js";
import { formatHelpExamples } from "../help-format.js";
import { parsePositiveIntOrUndefined } from "./helpers.js";

export function registerMoonshotCommands(program: Command) {
  program
    .command("moonshot:smoke")
    .description("Run Moonshot (Kimi) provider smoke test")
    .option("--json", "Output as JSON", false)
    .option("--base-url <url>", "API base URL (default: https://api.moonshot.ai/v1)")
    .option("--model <name>", "Model to use for test (default: kimi-k2-0905-preview)")
    .option("--timeout <ms>", "Request timeout in milliseconds", "30000")
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Description:")}\n` +
        `  Verifies Moonshot provider connectivity and auth.\n` +
        `  Requires MOONSHOT_API_KEY environment variable.\n`,
    )
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          ["moltbot moonshot:smoke", "Run smoke test with defaults"],
          ["moltbot moonshot:smoke --json", "Output results as JSON"],
          ["moltbot moonshot:smoke --model kimi-k2-0905-preview", "Use specific model"],
        ])}`,
    )
    .action(async (opts) => {
      const timeout = parsePositiveIntOrUndefined(opts.timeout);
      if (opts.timeout !== undefined && timeout === undefined) {
        defaultRuntime.error("--timeout must be a positive integer (milliseconds)");
        defaultRuntime.exit(1);
        return;
      }

      await runCommandWithRuntime(defaultRuntime, async () => {
        await moonshotSmokeCommand(
          {
            json: Boolean(opts.json),
            baseUrl: opts.baseUrl as string | undefined,
            model: opts.model as string | undefined,
            timeout,
          },
          defaultRuntime,
        );
      });
    });
}
