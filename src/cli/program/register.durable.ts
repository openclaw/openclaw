import type { Command } from "commander";
import { durableCommand, type DurableCliAction } from "../../commands/durable.js";
import { defaultRuntime } from "../../runtime.js";

type DurableCliCommanderOptions = {
  json?: boolean;
  limit?: string;
};

function parseLimit(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    defaultRuntime.error("--limit must be a positive integer.");
    defaultRuntime.exit(1);
    return undefined;
  }
  return parsed;
}

function addCommonOptions(command: Command): Command {
  return command.option("--json", "Output JSON instead of text", false);
}

async function runDurableAction(
  action: DurableCliAction,
  runtimeRunId: string | undefined,
  opts: DurableCliCommanderOptions,
): Promise<void> {
  await durableCommand(
    {
      action,
      runtimeRunId,
      json: Boolean(opts.json),
      limit: parseLimit(opts.limit),
    },
    defaultRuntime,
  );
}

export function registerDurableCommand(program: Command) {
  const durable = program
    .command("durable")
    .description("Inspect native durable runtime runs, timelines, and coordination state");

  addCommonOptions(durable.command("stats").description("Show durable runtime store stats")).action(
    async (opts) => {
      await runDurableAction("stats", undefined, opts);
    },
  );

  addCommonOptions(
    durable
      .command("runs")
      .description("List recent durable runtime runs")
      .option("--limit <count>", "Maximum runs to show", "50"),
  ).action(async (opts) => {
    await runDurableAction("runs", undefined, opts);
  });

  for (const [name, action, description] of [
    ["show", "show", "Show a durable runtime run with steps, links, signals, and timeline"],
    ["timeline", "timeline", "Show durable runtime events for one run"],
    ["steps", "steps", "Show durable runtime steps for one run"],
    ["children", "children", "Show child runtime links for one run"],
    ["parents", "parents", "Show parent runtime links for one run"],
    [
      "coordination",
      "coordination",
      "Show durable coordination projection for task/session runtime consumers",
    ],
    ["signals", "signals", "Show durable runtime signals for one run"],
    ["refs", "refs", "Show durable runtime state refs for one run"],
    ["timers", "timers", "Show durable runtime timers for one run"],
  ] as const) {
    addCommonOptions(durable.command(`${name} <runtimeRunId>`).description(description)).action(
      async (runtimeRunId: string, opts) => {
        await runDurableAction(action, runtimeRunId, opts);
      },
    );
  }
}
