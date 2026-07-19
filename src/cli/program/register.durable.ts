import fs from "node:fs";
import type { Command } from "commander";
import { durableCommand, type DurableCliAction } from "../../commands/durable.js";
import { createConfigIO, parseConfigJson5, validateConfigObjectRaw } from "../../config/config.js";
import type { DurableRuntimeConfig } from "../../config/types.durable.js";
import { defaultRuntime } from "../../runtime.js";

type DurableCliCommanderOptions = {
  json?: boolean;
  limit?: string;
};

type DurableCliContext = {
  durableConfig: DurableRuntimeConfig;
  env: NodeJS.ProcessEnv;
};

const DURABLE_CONFIG_LOAD_ERROR = "Unable to load OpenClaw config for durable inspection.";
const DURABLE_CONFIG_LOGGER = {
  error: () => {},
  warn: () => {},
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

async function loadDurableCliContext(): Promise<DurableCliContext> {
  const env = { ...process.env };
  const configIo = createConfigIO({
    env,
    logger: DURABLE_CONFIG_LOGGER,
    observe: false,
    pluginValidation: "skip",
    shellEnvFallback: "defer",
  });
  if (fs.existsSync(configIo.configPath)) {
    const parsed = parseConfigJson5(fs.readFileSync(configIo.configPath, "utf8"));
    if (!parsed.ok) {
      throw new Error(DURABLE_CONFIG_LOAD_ERROR);
    }
  }
  const sourceConfig = await configIo.readSourceConfigBestEffort();
  const validated = validateConfigObjectRaw(sourceConfig);
  if (!validated.ok) {
    throw new Error(DURABLE_CONFIG_LOAD_ERROR);
  }
  return {
    durableConfig: validated.config.durable ?? { mode: "off" },
    env,
  };
}

async function runDurableAction(
  action: DurableCliAction,
  runtimeRunId: string | undefined,
  opts: DurableCliCommanderOptions,
): Promise<void> {
  let context: DurableCliContext;
  try {
    context = await loadDurableCliContext();
  } catch {
    if (opts.json) {
      defaultRuntime.log(JSON.stringify({ error: DURABLE_CONFIG_LOAD_ERROR }, null, 2));
    } else {
      defaultRuntime.error(DURABLE_CONFIG_LOAD_ERROR);
    }
    defaultRuntime.exit(1);
    return;
  }
  await durableCommand(
    {
      action,
      runtimeRunId,
      json: Boolean(opts.json),
      limit: parseLimit(opts.limit),
      durableConfig: context.durableConfig,
      env: context.env,
    },
    defaultRuntime,
  );
}

export function registerDurableCommand(program: Command) {
  const durable = program
    .command("durable")
    .description("Inspect durable runtime runs, timelines, and coordination state");

  addCommonOptions(durable.command("stats").description("Show durable runtime store stats")).action(
    async (opts) => {
      await runDurableAction("stats", undefined, opts);
    },
  );

  addCommonOptions(
    durable.command("health").description("Show durable runtime authority health"),
  ).action(async (opts) => {
    await runDurableAction("health", undefined, opts);
  });

  addCommonOptions(
    durable
      .command("runs")
      .description("List recent durable runtime runs")
      .option("--limit <count>", "Maximum runs to show", "50"),
  ).action(async (opts) => {
    await runDurableAction("runs", undefined, opts);
  });

  const obligations = durable.command("obligations").description("Inspect unresolved obligations");
  addCommonOptions(
    obligations
      .command("list")
      .description("List unresolved durable obligations")
      .option("--limit <count>", "Maximum records to show", "50"),
  ).action(async (opts) => {
    await runDurableAction("obligations", undefined, opts);
  });

  const wakes = durable.command("wakes").description("Inspect durable wake obligations");
  addCommonOptions(
    wakes
      .command("list")
      .description("List durable wake obligations")
      .option("--limit <count>", "Maximum records to show", "50"),
  ).action(async (opts) => {
    await runDurableAction("wakes", undefined, opts);
  });
  addCommonOptions(
    wakes.command("inspect <wakeId>").description("Inspect one durable wake obligation"),
  ).action(async (wakeId: string, opts) => {
    await runDurableAction("wake", wakeId, opts);
  });
  const uncertainty = durable.command("uncertainty").description("Inspect uncertainty facts");
  addCommonOptions(
    uncertainty
      .command("list")
      .description("List unresolved durable uncertainty facts")
      .option("--limit <count>", "Maximum records to show", "50"),
  ).action(async (opts) => {
    await runDurableAction("uncertainty", undefined, opts);
  });
  const deliveryAttempts = durable
    .command("delivery-attempts")
    .description("Inspect delivery attempt evidence");
  addCommonOptions(
    deliveryAttempts
      .command("list <wakeId>")
      .description("List delivery attempt evidence for one wake obligation")
      .option("--limit <count>", "Maximum attempts to show", "50"),
  ).action(async (wakeId: string, opts) => {
    await runDurableAction("delivery-attempts", wakeId, opts);
  });

  for (const [name, action, description] of [
    ["show", "show", "Show a durable runtime run with steps, links, signals, and timeline"],
    ["timeline", "timeline", "Show durable runtime events for one run"],
    ["steps", "steps", "Show durable runtime steps for one run"],
    ["children", "children", "Show child runtime links for one run"],
    ["parents", "parents", "Show parent runtime links for one run"],
    ["why", "why", "Explain why a durable runtime run is quiet or what state it is in"],
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
