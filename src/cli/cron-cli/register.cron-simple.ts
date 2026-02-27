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
      .action(async (id, opts) => {
        try {
          // Try to remove directly first - cron.remove will fail if job doesn't exist
          const res = await callGatewayFromCli("cron.remove", opts, { id });
          const removed = res?.removed === true;

          if (opts.json) {
            defaultRuntime.log(JSON.stringify({ ok: true, removed, id }, null, 2));
          } else if (removed) {
            defaultRuntime.log(`✓ Removed job: ${id}`);
          } else {
            defaultRuntime.log(`⚠️  Job not removed: ${id}`);
          }
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : String(err);

          // Provide helpful error messages for common cases
          if (errorMessage.includes("not found") || errorMessage.includes("not exist")) {
            const errorMsg = opts.json
              ? JSON.stringify(
                  { ok: false, error: t("error.cron.jobNotFound", { id }), id },
                  null,
                  2,
                )
              : `❌ ${t("error.cron.jobNotFound", { id })}`;
            defaultRuntime.log(errorMsg);
          } else if (errorMessage.includes("running")) {
            const errorMsg = opts.json
              ? JSON.stringify({ ok: false, error: t("error.cron.jobRunning"), id }, null, 2)
              : `⚠️  ${t("error.cron.jobRunning")}`;
            defaultRuntime.log(errorMsg);
          } else {
            defaultRuntime.error(danger(errorMessage));
          }
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
          // Fetch all jobs across pages
          const allJobs: Array<{
            id?: string;
            name?: string;
            enabled?: boolean;
            state?: { runningAtMs?: number };
          }> = [];
          let offset: number | undefined;
          let hasMore = true;

          while (hasMore) {
            const listRes = (await callGatewayFromCli("cron.list", opts, {
              includeDisabled: true,
              offset,
              limit: 200, // Max page size
            })) as {
              jobs?: Array<{
                id?: string;
                name?: string;
                enabled?: boolean;
                state?: { runningAtMs?: number };
              }>;
              hasMore?: boolean;
              nextOffset?: number;
            } | null;

            const jobs = listRes?.jobs ?? [];
            allJobs.push(...jobs);

            hasMore = listRes?.hasMore ?? false;
            offset = listRes?.nextOffset;

            // Safety limit to prevent infinite loops
            if (allJobs.length >= 10000) {
              break;
            }
          }

          // Find jobs with issues - stuck in running state for too long (over 2 hours)
          // Align with scheduler's STUCK_RUN_MS threshold (2 hours) to avoid clearing
          // running markers early for legitimate long-running jobs
          const STUCK_RUN_MS = 2 * 60 * 60 * 1000;
          const staleJobs = allJobs.filter((j) => {
            if (j.state?.runningAtMs) {
              const runningFor = Date.now() - j.state.runningAtMs;
              return runningFor > STUCK_RUN_MS;
            }
            return false;
          });

          const disabledJobs = allJobs.filter((j) => j.enabled === false);

          if (opts.dryRun) {
            const result = {
              ok: true,
              dryRun: true,
              staleJobs: staleJobs.length,
              disabledJobs: disabledJobs.length,
              totalJobs: allJobs.length,
            };
            defaultRuntime.log(
              opts.json
                ? JSON.stringify(result, null, 2)
                : `Dry run results:
- Stale jobs (running >1h): ${staleJobs.length}
- Disabled jobs: ${disabledJobs.length}
- Total jobs: ${allJobs.length}

Run without --dry-run to clean up stale jobs.`,
            );
            return;
          }

          // Clean up stale jobs by disabling then re-enabling to reset runningAtMs
          let cleaned = 0;
          const failedJobs: Array<{ id?: string; name?: string; error: string }> = [];

          for (const job of staleJobs) {
            const wasEnabled = job.enabled !== false;

            try {
              // First disable to reset runningAtMs
              await callGatewayFromCli("cron.update", opts, {
                id: job.id,
                patch: { enabled: false },
              });

              // Then re-enable if it was originally enabled
              if (wasEnabled) {
                try {
                  await callGatewayFromCli("cron.update", opts, {
                    id: job.id,
                    patch: { enabled: true },
                  });
                } catch (enableErr) {
                  // Re-enable failed - job is now disabled but should be enabled
                  const errorMsg = enableErr instanceof Error ? enableErr.message : String(enableErr);
                  failedJobs.push({
                    id: job.id,
                    name: job.name,
                    error: `Failed to re-enable job after cleanup: ${errorMsg}`,
                  });
                  continue; // Don't count as cleaned
                }
              }

              cleaned++;
            } catch (err) {
              const errorMsg = err instanceof Error ? err.message : String(err);
              failedJobs.push({
                id: job.id,
                name: job.name,
                error: errorMsg,
              });
            }
          }

          // Report any failures
          if (failedJobs.length > 0) {
            const failedIds = failedJobs.map((j) => j.id || "unknown").join(", ");
            defaultRuntime.log(`⚠️  Failed to clean up ${failedJobs.length} job(s): ${failedIds}`);
            for (const failed of failedJobs) {
              defaultRuntime.log(`  - ${failed.id}${failed.name ? ` (${failed.name})` : ""}: ${failed.error}`);
            }
          }

          const result = {
            ok: true,
            cleaned,
            staleJobs: staleJobs.length,
            disabledJobs: disabledJobs.length,
            totalJobs: allJobs.length,
          };

          if (opts.json) {
            defaultRuntime.log(JSON.stringify(result, null, 2));
          } else {
            defaultRuntime.log(`✓ Cleanup complete:
- Reset ${cleaned} stale jobs
- Found ${disabledJobs.length} disabled jobs (use 'cron rm' to remove)
- Total jobs: ${allJobs.length}`);
          }
        } catch (err) {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        }
      }),
  );
}
