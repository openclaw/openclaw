import type { Command } from "commander";
import type { CronJob } from "../../cron/types.js";
import { defaultRuntime } from "../../runtime.js";
import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";
import { addGatewayClientOptions, callGatewayFromCli } from "../gateway-rpc.js";
import {
  coerceCronDeliveryPreviews,
  handleCronCliError,
  printCronJson,
  printCronShow,
  warnIfCronSchedulerDisabled,
} from "./shared.js";

function findCronJobForShow(jobs: CronJob[], idOrName: string): CronJob | undefined {
  const needle = normalizeLowercaseStringOrEmpty(idOrName);
  return jobs.find(
    (job) =>
      normalizeLowercaseStringOrEmpty(job.id) === needle ||
      normalizeLowercaseStringOrEmpty(job.name) === needle,
  );
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
          printCronJson(res);
          await warnIfCronSchedulerDisabled(opts);
        } catch (err) {
          handleCronCliError(err);
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
          printCronJson(res);
        } catch (err) {
          handleCronCliError(err);
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
      .command("show")
      .description("Show a cron job")
      .argument("<id>", "Job id or exact name")
      .option("--json", "Output JSON", false)
      .action(async (id, opts) => {
        try {
          const res = await callGatewayFromCli("cron.list", opts, { includeDisabled: true });
          const jobs = (res as { jobs?: CronJob[] } | null)?.jobs ?? [];
          const job = findCronJobForShow(jobs, String(id));
          if (!job) {
            throw new Error(`cron job not found: ${String(id)}`);
          }
          if (opts.json) {
            printCronJson(job);
            return;
          }
          const deliveryPreviews = coerceCronDeliveryPreviews(res);
          printCronShow(job, defaultRuntime, { deliveryPreview: deliveryPreviews.get(job.id) });
        } catch (err) {
          handleCronCliError(err);
        }
      }),
  );

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
          printCronJson(res);
        } catch (err) {
          handleCronCliError(err);
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
          const res = await callGatewayFromCli("cron.run", opts, {
            id,
            mode: opts.due ? "due" : "force",
          });
          printCronJson(res);
          const result = res as { ok?: boolean; ran?: boolean; enqueued?: boolean } | undefined;
          defaultRuntime.exit(result?.ok && (result?.ran || result?.enqueued) ? 0 : 1);
        } catch (err) {
          handleCronCliError(err);
        }
      }),
  );
}
