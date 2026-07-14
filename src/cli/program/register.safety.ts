// AI safety event observability command registration.
import type { Command } from "commander";
import { formatDocsLink } from "../../../packages/terminal-core/src/links.js";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import {
  safetyEventsCommand,
  type SafetyEventsCommandOptions,
} from "../../commands/safety.js";
import { defaultRuntime } from "../../runtime.js";
import { runCommandWithRuntime } from "../cli-utils.js";

/** Register the AI safety events observability command. */
export function registerSafetyCommand(program: Command): void {
  const safety = program
    .command("safety")
    .description("Inspect AI safety taxonomy events");

  safety
    .command("events")
    .description("List AI safety events from the in-process ring buffer")
    .option("--type <type>", "Filter by event type (e.g. ai_safety.refusal)")
    .option("--session <id>", "Filter by session id")
    .option(
      "--since <duration>",
      'Only show events within this duration (e.g. 1h, 30m, 2d)',
    )
    .option("--limit <count>", "Maximum records (1-500)", "100")
    .option(
      "--severity <level>",
      "Filter by severity (info, low, medium, high, critical)",
    )
    .option("--cursor <sequence>", "Continue from a previous result cursor")
    .option("--json", "Output a bounded JSON page", false)
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink(
          "/cli/safety",
          "docs.openclaw.ai/cli/safety",
        )}\n`,
    )
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        await safetyEventsCommand(
          {
            type: opts.type as string | undefined,
            session: opts.session as string | undefined,
            since: opts.since as string | undefined,
            limit: opts.limit as string | undefined,
            severity: opts.severity as SafetyEventsCommandOptions["severity"],
            cursor: opts.cursor as string | undefined,
            json: Boolean(opts.json),
          },
          defaultRuntime,
        );
      });
    });
}
