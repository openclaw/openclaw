import type { Command } from "commander";
import { danger } from "../../globals.js";
import { t } from "../../i18n/index.js";
import { defaultRuntime } from "../../runtime.js";
import { addGatewayClientOptions, callGatewayFromCli } from "../gateway-rpc.js";
import { warnIfCronSchedulerDisabled } from "./shared.js";

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
      .option("--force", "Force removal even if job is running", false)
      .action(async (id, opts) => {
        try {
          // First check if job exists and get its status
          const listRes = (await callGatewayFromCli("cron.list", opts, {})) as { jobs?: Array<{ id?: string; name?: string; state?: { runningAtMs?: number } }> } | null;
          const jobs = listRes?.jobs ?? [];
          const job = jobs.find((j) => j.id === id || j.name === id);

          if (!job) {
            const errorMsg = opts.json
              ? JSON.stringify({ ok: false, error: t("error.cron.jobNotFound", { id }), id }, null, 2)
              : `❌ ${t("error.cron.jobNotFound", { id })}`;
            defaultRuntime.log(errorMsg);
            defaultRuntime.exit(1);
            return;
          }

          const jobId = job.id;
          const isRunning = job.state?.runningAtMs != null;

          if (isRunning && !opts.force) {
            const errorMsg = opts.json
              ? JSON.stringify({ ok: false, error: t("error.cron.jobRunning"), id: jobId }, null, 2)
              : `⚠️  ${t("error.cron.jobRunning")}`;
            defaultRuntime.log(errorMsg);
            defaultRuntime.exit(1);
            return;
          }

          const res = await callGatewayFromCli("cron.remove", opts, { id: jobId });
          const removed = res?.removed === true;

          if (opts.json) {
            defaultRuntime.log(JSON.stringify({ ok: true, removed, id: jobId }, null, 2));
          } else if (removed) {
            defaultRuntime.log(`✓ ${t("success.cron.jobRemoved", { name: job.name ?? jobId })} (${jobId})`);
          } else {
            defaultRuntime.log(`⚠️  Job not removed: ${job.name ?? jobId} (${jobId})`);
          }
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
      .action(async (id, opts) => {
        try {
          const res = await callGatewayFromCli("cron.run", opts, {
            id,
            mode: opts.due ? "due" : "force",
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
      .command("cleanup")
      .description("Clean up stale cron job entries and orphaned run logs")
      .option("--dry-run", "Show what would be cleaned up without making changes", false)
      .option("--json", "Output JSON", false)
      .action(async (opts) => {
        try {
          const listRes = (await callGatewayFromCli("cron.list", opts, { includeDisabled: true })) as { jobs?: Array<{ id?: string; name?: string; enabled?: boolean; state?: { runningAtMs?: number } }> } | null;
          const jobs = listRes?.jobs ?? [];

          // Find jobs with issues - stuck in running state for too long (over 1 hour)
          const staleJobs = jobs.filter((j) => {
            if (j.state?.runningAtMs) {
              const runningFor = Date.now() - j.state.runningAtMs;
              return runningFor > 60 * 60 * 1000; // 1 hour
            }
            return false;
          });

          const disabledJobs = jobs.filter((j) => j.enabled === false);

          if (opts.dryRun) {
            const result = {
              ok: true,
              dryRun: true,
              staleJobs: staleJobs.length,
              disabledJobs: disabledJobs.length,
              totalJobs: jobs.length,
            };
            defaultRuntime.log(opts.json ? JSON.stringify(result, null, 2) : `Dry run results:
- Stale jobs (running >1h): ${staleJobs.length}
- Disabled jobs: ${disabledJobs.length}
- Total jobs: ${jobs.length}

Run without --dry-run to clean up stale jobs.`);
            return;
          }

          // Clean up stale jobs by disabling then re-enabling to reset runningAtMs
          let cleaned = 0;
          for (const job of staleJobs) {
            try {
              const wasEnabled = job.enabled !== false;

              // First disable to reset runningAtMs
              await callGatewayFromCli("cron.update", opts, {
                id: job.id,
                patch: { enabled: false },
              });

              // Then re-enable if it was originally enabled
              if (wasEnabled) {
                await callGatewayFromCli("cron.update", opts, {
                  id: job.id,
                  patch: { enabled: true },
                });
              }

              cleaned++;
            } catch {
              // Ignore errors for individual jobs
            }
          }

          const result = {
            ok: true,
            cleaned,
            staleJobs: staleJobs.length,
            disabledJobs: disabledJobs.length,
            totalJobs: jobs.length,
          };

          if (opts.json) {
            defaultRuntime.log(JSON.stringify(result, null, 2));
          } else {
            defaultRuntime.log(`✓ Cleanup complete:
- Reset ${cleaned} stale jobs
- Found ${disabledJobs.length} disabled jobs (use 'cron rm' to remove)
- Total jobs: ${jobs.length}`);
          }
        } catch (err) {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        }
      }),
  );
}
