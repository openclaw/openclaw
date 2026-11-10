import type { Command } from "commander";
import { defaultRuntime } from "../../runtime.js";
import { getAsyncWorkSignal } from "../../shared/async-work-scope.js";
import {
  addGatewayClientOptions,
  callGatewayFromCli,
  type GatewayRpcOpts,
} from "../gateway-rpc.js";
import { CronCliError } from "./cron-cli-error.js";
import { listCronJobsFromGateway } from "./list-jobs.js";
import { createCronOutputCommand } from "./output-mode.js";
import { handleCronCliError } from "./shared.js";

/** Explicit owner opt-in; each job uses the same revision-checked Gateway validator as edit. */
export function registerCronReviewModelPolicyCommand(cron: Command) {
  addGatewayClientOptions(
    createCronOutputCommand(cron, "review-model-policy")
      .description("Review fallback account authorizations for selected automations")
      .argument("[ids...]", "Exact job IDs")
      .option("--all", "Review all automations visible to this caller", false)
      .option("--dry-run", "Preview without changing any job", false)
      .action(async (ids: string[], opts: GatewayRpcOpts & { all?: boolean; dryRun?: boolean }) => {
        try {
          if (Boolean(opts.all) === ids.length > 0) {
            throw new CronCliError("Choose exact job IDs or --all");
          }
          const selected = opts.all
            ? (await listCronJobsFromGateway(opts, { includeDisabled: true })).jobs.map(
                (job) => job.id,
              )
            : [...new Set(ids)];
          const results: Array<{ id: string; result?: unknown; error?: string }> = [];
          const signal = getAsyncWorkSignal();
          for (const id of selected) {
            if (signal?.aborted) {
              break;
            }
            try {
              const job = await callGatewayFromCli("cron.get", opts, { id }, { signal });
              signal?.throwIfAborted();
              if (typeof job.configRevision !== "string" || !job.configRevision) {
                throw new CronCliError(
                  "The Gateway did not return a configuration revision; no change was attempted",
                );
              }
              const result = await callGatewayFromCli(
                "cron.update",
                opts,
                {
                  id,
                  patch: {},
                  reviewModelPolicy: true,
                  dryRun: opts.dryRun === true,
                  expectedConfigRevision: job.configRevision,
                },
                { signal },
              );
              results.push({ id, result });
            } catch (error) {
              // An uncertain write is reported once, never replayed or silently rebased.
              results.push({ id, error: error instanceof Error ? error.message : String(error) });
            }
          }
          defaultRuntime.writeJson({
            dryRun: opts.dryRun === true,
            cancelled: signal?.aborted === true,
            results,
          });
        } catch (error) {
          handleCronCliError(error);
        }
      }),
  );
}
