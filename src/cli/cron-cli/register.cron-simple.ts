import type { Command } from "commander";
import { danger } from "../../globals.js";
import { defaultRuntime } from "../../runtime.js";
import { addGatewayClientOptions, callGatewayFromCli } from "../gateway-rpc.js";
import { warnIfCronSchedulerDisabled } from "./shared.js";

type CronRunTriggerResult = {
  ok?: boolean;
  ran?: boolean;
};

type CronRunsEntry = {
  action?: string;
  runAtMs?: number;
  status?: string;
};

type CronRunsResult = {
  entries?: CronRunsEntry[];
};

function parseTimeoutMs(raw: string | undefined, fallbackMs: number): number {
  const parsed = Number.parseInt(String(raw ?? fallbackMs), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackMs;
}

export async function waitForCronRunFinalEntry(
  id: string,
  opts: { timeout?: string; expectFinal?: boolean; json?: boolean; url?: string; token?: string },
  triggerRequestedAtMs: number,
): Promise<CronRunsEntry | null> {
  const timeoutMs = parseTimeoutMs(opts.timeout, 600_000);
  const deadline = Date.now() + timeoutMs;
  const pollOpts = {
    ...opts,
    expectFinal: false,
  };

  while (Date.now() <= deadline) {
    const remainingMs = Math.max(1_000, deadline - Date.now());
    pollOpts.timeout = String(Math.min(10_000, remainingMs));
    const runsRes = (await callGatewayFromCli(
      "cron.runs",
      pollOpts,
      {
        id,
        limit: 20,
      },
      { expectFinal: false },
    )) as CronRunsResult;
    const entries = Array.isArray(runsRes?.entries) ? runsRes.entries : [];
    const match =
      entries.find(
        (entry) =>
          entry?.action === "finished" &&
          typeof entry?.runAtMs === "number" &&
          entry.runAtMs >= triggerRequestedAtMs - 1_000,
      ) ?? null;
    if (match) {
      return match;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  return null;
}

function registerCronToggleCommand(params: {
  cron: Command;
  name: "enable" | "disable";
  description: string;
  enabled: boolean;
}) {
  addGatewayClientOptions(
    params.cron
      .command(params.name)
      .description(params.description)
      .argument("<id>", "Job id")
      .action(async (id, opts) => {
        try {
          const res = await callGatewayFromCli("cron.update", opts, {
            id,
            patch: { enabled: params.enabled },
          });
          defaultRuntime.log(JSON.stringify(res, null, 2));
          await warnIfCronSchedulerDisabled(opts);
        } catch (err) {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        }
      }),
  );
}

export function registerCronSimpleCommands(cron: Command) {
  addGatewayClientOptions(
    cron
      .command("rm")
      .alias("remove")
      .alias("delete")
      .description("Remove a cron job")
      .argument("<id>", "Job id")
      .option("--json", "Output JSON", false)
      .action(async (id, opts) => {
        try {
          const res = await callGatewayFromCli("cron.remove", opts, { id });
          defaultRuntime.log(JSON.stringify(res, null, 2));
        } catch (err) {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        }
      }),
  );

  registerCronToggleCommand({
    cron,
    name: "enable",
    description: "Enable a cron job",
    enabled: true,
  });
  registerCronToggleCommand({
    cron,
    name: "disable",
    description: "Disable a cron job",
    enabled: false,
  });

  addGatewayClientOptions(
    cron
      .command("runs")
      .description("Show cron run history (JSONL-backed)")
      .requiredOption("--id <id>", "Job id")
      .option("--limit <n>", "Max entries (default 50)", "50")
      .action(async (opts) => {
        try {
          const limitRaw = Number.parseInt(String(opts.limit ?? "50"), 10);
          const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 50;
          const id = String(opts.id);
          const res = await callGatewayFromCli("cron.runs", opts, {
            id,
            limit,
          });
          defaultRuntime.log(JSON.stringify(res, null, 2));
        } catch (err) {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        }
      }),
  );

  addGatewayClientOptions(
    cron
      .command("run")
      .description("Run a cron job now (debug)")
      .argument("<id>", "Job id")
      .option("--due", "Run only when due (default behavior in older versions)", false)
      .action(async (id, opts, command) => {
        try {
          if (command.getOptionValueSource("timeout") === "default") {
            opts.timeout = "600000";
          }
          const triggerRequestedAtMs = Date.now();
          const res = await callGatewayFromCli("cron.run", opts, {
            id,
            mode: opts.due ? "due" : "force",
          });
          const result = res as CronRunTriggerResult | undefined;
          if (opts.expectFinal && result?.ok && result?.ran) {
            const finalEntry = await waitForCronRunFinalEntry(id, opts, triggerRequestedAtMs);
            if (!finalEntry) {
              defaultRuntime.error(danger(`Timed out waiting for final cron result for job ${id}`));
              defaultRuntime.exit(1);
              return;
            }
            defaultRuntime.log(JSON.stringify(finalEntry, null, 2));
            defaultRuntime.exit(finalEntry.status === "ok" ? 0 : 1);
            return;
          }
          defaultRuntime.log(JSON.stringify(res, null, 2));
          defaultRuntime.exit(result?.ok && result?.ran ? 0 : 1);
        } catch (err) {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        }
      }),
  );
}
