import type { Command } from "commander";
import {
  durableCommand,
  type DurableCliAction,
  type DurableCliOptions,
} from "../../commands/durable.js";
import { defaultRuntime } from "../../runtime.js";

type DurableCliCommanderOptions = {
  json?: boolean;
  store?: string;
  limit?: string;
  reason?: string;
  delayMs?: string;
  type?: string;
  correlationId?: string;
  idempotencyKey?: string;
  payloadJson?: string;
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

function parseNonNegativeInteger(value: string | undefined, flagName: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    defaultRuntime.error(`${flagName} must be a non-negative integer.`);
    defaultRuntime.exit(1);
    return undefined;
  }
  return parsed;
}

function parsePayloadJson(value: string | undefined): Record<string, unknown> | undefined {
  if (value === undefined) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // The explicit error below is clearer than leaking JSON parser internals.
  }
  defaultRuntime.error("--payload-json must be a JSON object.");
  defaultRuntime.exit(1);
  return undefined;
}

function parseSignalType(value: string | undefined): DurableCliOptions["signalType"] {
  if (
    value === undefined ||
    value === "human_input" ||
    value === "approval" ||
    value === "rejection" ||
    value === "external_callback" ||
    value === "cancel" ||
    value === "resume"
  ) {
    return value;
  }
  defaultRuntime.error(
    "--type must be one of: human_input, approval, rejection, external_callback, cancel, resume.",
  );
  defaultRuntime.exit(1);
  return undefined;
}

function addCommonOptions(command: Command): Command {
  return command
    .option("--json", "Output JSON instead of text", false)
    .option("--store <path>", "Path to durable workflow SQLite store");
}

async function runDurableAction(
  action: DurableCliAction,
  workflowRunId: string | undefined,
  opts: DurableCliCommanderOptions,
): Promise<void> {
  await durableCommand(
    {
      action,
      workflowRunId,
      json: Boolean(opts.json),
      store: opts.store,
      limit: parseLimit(opts.limit),
      reason: opts.reason,
      delayMs: parseNonNegativeInteger(opts.delayMs, "--delay-ms"),
      signalType: parseSignalType(opts.type),
      correlationId: opts.correlationId,
      idempotencyKey: opts.idempotencyKey,
      payload: parsePayloadJson(opts.payloadJson),
    },
    defaultRuntime,
  );
}

export function registerDurableCommand(program: Command) {
  const durable = program
    .command("durable")
    .description("Inspect native durable workflow runs, timelines, and coordination state");

  addCommonOptions(
    durable.command("stats").description("Show durable workflow store stats"),
  ).action(async (opts) => {
    await runDurableAction("stats", undefined, opts);
  });

  addCommonOptions(
    durable
      .command("runs")
      .description("List recent durable workflow runs")
      .option("--limit <count>", "Maximum runs to show", "50"),
  ).action(async (opts) => {
    await runDurableAction("runs", undefined, opts);
  });

  for (const [name, action, description] of [
    ["show", "show", "Show a durable workflow run with steps, links, signals, and timeline"],
    ["timeline", "timeline", "Show durable workflow events for one run"],
    ["steps", "steps", "Show durable workflow steps for one run"],
    ["children", "children", "Show child workflow links for one run"],
    ["parents", "parents", "Show parent workflow links for one run"],
    [
      "coordination",
      "coordination",
      "Show durable coordination projection for task, TaskFlow, and Workboard",
    ],
    ["signals", "signals", "Show durable workflow signals for one run"],
    ["refs", "refs", "Show durable workflow state refs for one run"],
    ["timers", "timers", "Show durable workflow timers for one run"],
  ] as const) {
    addCommonOptions(durable.command(`${name} <workflowRunId>`).description(description)).action(
      async (workflowRunId: string, opts) => {
        await runDurableAction(action, workflowRunId, opts);
      },
    );
  }

  addCommonOptions(
    durable
      .command("cancel <workflowRunId>")
      .description("Cancel a durable workflow run in the control plane")
      .option("--reason <text>", "Reason recorded in the durable event log"),
  ).action(async (workflowRunId: string, opts) => {
    await runDurableAction("cancel", workflowRunId, opts);
  });

  addCommonOptions(
    durable
      .command("retry <workflowRunId>")
      .description("Queue or schedule retry for a durable workflow run")
      .option("--delay-ms <ms>", "Delay before retry is due", "0")
      .option("--reason <text>", "Reason recorded in the durable event log"),
  ).action(async (workflowRunId: string, opts) => {
    await runDurableAction("retry", workflowRunId, opts);
  });

  addCommonOptions(
    durable
      .command("resume <workflowRunId>")
      .description("Move a waiting durable workflow run back to runnable state")
      .option("--reason <text>", "Reason recorded in the durable event log"),
  ).action(async (workflowRunId: string, opts) => {
    await runDurableAction("resume", workflowRunId, opts);
  });

  addCommonOptions(
    durable
      .command("signal <workflowRunId>")
      .description("Record a human or external signal for a durable workflow run")
      .option(
        "--type <type>",
        "Signal type: human_input, approval, rejection, external_callback, cancel, resume",
        "human_input",
      )
      .option("--payload-json <json>", "JSON object stored as signal payload metadata")
      .option("--correlation-id <id>", "External correlation id")
      .option("--idempotency-key <key>", "Idempotency key for duplicate signal suppression")
      .option("--reason <text>", "Reason recorded in the durable event log"),
  ).action(async (workflowRunId: string, opts) => {
    await runDurableAction("signal", workflowRunId, opts);
  });

  addCommonOptions(
    durable
      .command("mark-unknown <workflowRunId>")
      .description("Mark a run as unknown after a possible side effect")
      .option("--reason <text>", "Reason recorded in the durable event log"),
  ).action(async (workflowRunId: string, opts) => {
    await runDurableAction("mark-unknown", workflowRunId, opts);
  });
}
