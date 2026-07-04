// `openclaw stats`: local usage statistics aggregated from session stores.
import type { Command } from "commander";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import { setVerbose } from "../../globals.js";
import { defaultRuntime } from "../../runtime.js";
import { formatHelpExamples } from "../help-format.js";

type StatsUsageCliOptions = {
  json?: boolean;
  verbose?: boolean;
  store?: string;
  agent?: string;
  allAgents?: boolean;
  since?: string;
  until?: string;
  provider?: string;
};

function addStatsUsageOptions(command: Command): Command {
  return command
    .option("--json", "Output as JSON", false)
    .option("--verbose", "Verbose logging", false)
    .option("--store <path>", "Path to session store (default: resolved from config)")
    .option("--agent <id>", "Agent id to inspect (default: configured default agent)")
    .option("--all-agents", "Aggregate usage across all configured agents", false)
    .option("--since <when>", "Only include sessions updated since a duration (e.g. 7d) or date")
    .option("--until <when>", "Only include sessions updated before a duration (e.g. 1d) or date")
    .option("--provider <id>", "Only include sessions for a model provider");
}

async function runStatsUsageCli(opts: StatsUsageCliOptions): Promise<void> {
  setVerbose(Boolean(opts.verbose));
  const { statsUsageCommand } = await import("../../commands/stats.js");
  await statsUsageCommand(
    {
      json: Boolean(opts.json),
      store: opts.store,
      agent: opts.agent,
      allAgents: Boolean(opts.allAgents),
      since: opts.since,
      until: opts.until,
      provider: opts.provider,
    },
    defaultRuntime,
  );
}

/** Register the `stats` command group and its `usage` subcommand. */
export function registerStatsCli(program: Command): void {
  // Bare `openclaw stats` runs the usage summary; the explicit `usage`
  // subcommand shares the same options and action.
  const stats = addStatsUsageOptions(
    program.command("stats").description("Show local agent usage statistics"),
  )
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples([
          ["openclaw stats", "Aggregate token usage across sessions."],
          ["openclaw stats --agent work", "Usage for one agent."],
          ["openclaw stats --all-agents", "Aggregate usage across agents."],
          ["openclaw stats --since 7d", "Only sessions from the last 7 days."],
          ["openclaw stats --provider anthropic", "Only sessions for one provider."],
          ["openclaw stats --json", "Machine-readable output."],
        ])}`,
    )
    .action(async (opts: StatsUsageCliOptions) => {
      await runStatsUsageCli(opts);
    });

  addStatsUsageOptions(
    stats.command("usage").description("Aggregate token usage across stored sessions"),
  ).action(async (opts: StatsUsageCliOptions) => {
    await runStatsUsageCli(opts);
  });
}
