import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { Option, type Command } from "commander";
import { resolveCronCompletionStatus } from "../../cron/completion-status.js";
import type { CronRunLogEntry } from "../../cron/run-log-types.js";
import {
  formatCronRunCostRollup,
  mergeCronRunCostRollups,
  rollupCronRunCost,
  type CronRunCostRollup,
} from "../../cron/run-cost-rollup.js";
import { defaultRuntime } from "../../runtime.js";
import { sleep } from "../../utils/sleep.js";
import type { GatewayRpcOpts } from "../gateway-rpc.js";
import { addGatewayClientOptions, callGatewayFromCli } from "../gateway-rpc.js";
import { exitCliAfterOutput } from "../one-shot-exit.js";
import { parseDurationMs } from "../parse-duration.js";
import { parseTimeoutMs } from "../parse-timeout.js";
import { CronCliError } from "./cron-cli-error.js";
import { findCronJobByIdOrName } from "./list-jobs.js";
import { createCronOutputCommand } from "./output-mode.js";
import {
  enrichCronJsonWithStatus,
  formatCronLookupMiss,
  handleCronCliError,
  parseCronIntegerOption,
  printCronJson,
  printCronShow,
  requireCronJobId,
  warnIfCronSchedulerDisabled,
} from "./shared.js";

/**
 * Untyped Gateway CLI RPC JSON → caller-requested shape.
 * Honest cast boundary (no runtime schema): protocol responses are validated
 * only by field access at call sites. Kept as a single SAFETY site so the
 * assertion-safety ratchet does not grow free `as` casts in this file.
 */
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- CLI helper lets call sites ascribe untyped Gateway RPC JSON.
function readGatewayShape<T>(value: unknown): T {
  // SAFETY: gateway CLI JSON is untyped; callers request the expected shape via T.
  return value as T;
}

const CRON_SHOW_PAGE_SIZE = 200;
const CRON_SHOW_LOOKUP_MAX_PAGES = 50;
/** Fleet-wide cron stats without --id: hard cap on jobs polled (avoids 10k sequential RPCs). */
const CRON_STATS_MAX_JOBS = 25;
const CRON_RUN_WAIT_TIMEOUT_DEFAULT = "10m";
const CRON_RUN_WAIT_POLL_INTERVAL_DEFAULT = "2s";

type CronRunCommandResult = {
  ok?: boolean;
  ran?: boolean;
  enqueued?: boolean;
  runId?: string;
};

function parseCronRunWaitDuration(raw: unknown): number {
  const input =
    typeof raw === "string" || typeof raw === "number" || typeof raw === "bigint"
      ? String(raw)
      : "";
  let durationMs: number;
  try {
    durationMs = parseDurationMs(input, { defaultUnit: "ms" });
  } catch (error) {
    if (error instanceof Error) {
      throw new CronCliError(error);
    }
    throw error;
  }
  return resolveTimerTimeoutMs(durationMs, 0, 0);
}

async function waitForCronRunCompletion(params: {
  opts: GatewayRpcOpts;
  jobId: string;
  runId: string;
  timeoutMs: number;
  pollIntervalMs: number;
}): Promise<CronRunLogEntry> {
  // Poll the task ledger rather than cron.run because completion state is written asynchronously.
  const startedAt = performance.now();
  let hasPolled = false;
  for (;;) {
    const elapsedBeforePollMs = Math.floor(performance.now() - startedAt);
    if (hasPolled && elapsedBeforePollMs >= params.timeoutMs) {
      throw new CronCliError(`timed out waiting for cron run ${params.runId}`);
    }
    const remainingMs = Math.max(1, params.timeoutMs - elapsedBeforePollMs);
    const configuredTimeoutMs = parseTimeoutMs(params.opts.timeout);
    const pollTimeoutMs =
      configuredTimeoutMs === undefined ? remainingMs : Math.min(configuredTimeoutMs, remainingMs);
    hasPolled = true;
    // History reads share the wait deadline, but enqueue keeps its own RPC
    // timeout and a zero-duration wait still gets one immediate ledger poll.
    const pollOpts = { ...params.opts, timeout: String(pollTimeoutMs) };
    const pageRaw = await callGatewayFromCli("cron.runs", pollOpts, {
      id: params.jobId,
      runId: params.runId,
      limit: 1,
    });
    const page = readGatewayShape<{ entries?: CronRunLogEntry[] }>(pageRaw);
    const entry = page.entries?.[0];
    if (entry?.status === "ok" || entry?.status === "error" || entry?.status === "skipped") {
      return entry;
    }
    const elapsedMs = Math.floor(performance.now() - startedAt);
    if (elapsedMs >= params.timeoutMs) {
      throw new CronCliError(`timed out waiting for cron run ${params.runId}`);
    }
    await sleep(Math.min(params.pollIntervalMs, params.timeoutMs - elapsedMs));
  }
}

export function registerCronSimpleCommands(cron: Command) {
  for (const [name, description, method] of [
    ["rm", "Remove an automation", "cron.remove"],
    ["enable", "Enable an automation", "cron.update"],
    ["disable", "Disable an automation", "cron.update"],
    ["get", "Get an automation as JSON", "cron.get"],
  ] as const) {
    addGatewayClientOptions(
      createCronOutputCommand(cron, name)
        .description(description)
        .argument("<id>", "Job id")
        .action(async (id, opts) => {
          try {
            const res = await callGatewayFromCli(method, opts, {
              id: requireCronJobId(id),
              ...(method === "cron.update" ? { patch: { enabled: name === "enable" } } : {}),
            });
            printCronJson(res);
            if (name === "disable" && process.stderr.isTTY) {
              process.stderr.write(
                `Note: 'openclaw cron list' hides disabled jobs by default. Use 'openclaw cron list --all' to see this job, or 'openclaw cron enable <id>' to re-enable it.\n`,
              );
            }
            if (method === "cron.update") {
              await warnIfCronSchedulerDisabled(opts);
            }
          } catch (err) {
            handleCronCliError(err);
          }
        }),
    );
  }

  addGatewayClientOptions(
    cron
      .command("show")
      .description("Show an automation")
      .argument("<id>", "Job id or exact name")
      .option("--json", "Output JSON", false)
      .action(async (idArg, opts) => {
        try {
          const id = requireCronJobId(idArg);
          const { job, deliveryPreview } = await findCronJobByIdOrName(opts, id, {
            includeDeliveryPreview: !opts.json,
          });
          if (!job) {
            throw new CronCliError(formatCronLookupMiss(id));
          }
          if (opts.json) {
            printCronJson(enrichCronJsonWithStatus(job));
            return;
          }
          printCronShow(job, defaultRuntime, { deliveryPreview });
        } catch (err) {
          handleCronCliError(err);
        }
      }),
  );

  addGatewayClientOptions(
    createCronOutputCommand(cron, "runs")
      .description("Show automation run history")
      .argument("[id]", "Job id")
      .option("--id <id>", "Job id (alternative to positional argument)")
      .option("--all", "Show run history across all visible automations", false)
      .option("--run-id <runId>", "Filter by cron run id")
      .addOption(
        new Option("--status <status>", "Filter by run status").choices([
          "all",
          "ok",
          "error",
          "skipped",
        ]),
      )
      .addOption(
        new Option("--delivery-status <status>", "Filter by delivery status").choices([
          "delivered",
          "not-delivered",
          "unknown",
          "not-requested",
        ]),
      )
      .option("--query <text>", "Filter by run summary or error text")
      .option("--offset <n>", "Entries to skip before returning results")
      .addOption(new Option("--sort <direction>", "Sort by run time").choices(["asc", "desc"]))
      .option("--limit <n>", "Max entries (default 50)", "50")
      .action(async (idArg, opts) => {
        try {
          const argId = normalizeOptionalString(idArg);
          const flagId = normalizeOptionalString(opts.id);
          if (argId && flagId && argId !== flagId) {
            throw new CronCliError(
              `Conflicting job ids: positional "${argId}" and --id "${flagId}".`,
            );
          }
          if (opts.all && (idArg !== undefined || opts.id !== undefined)) {
            throw new CronCliError("--all cannot be combined with a job id");
          }
          const id = opts.all
            ? undefined
            : requireCronJobId(argId ?? flagId, "Pass it positionally or with --id.");
          const limit = parseCronIntegerOption(opts.limit ?? "50", "--limit");
          const offset = parseCronIntegerOption(opts.offset, "--offset", "non-negative");
          if (typeof opts.runId === "string" && !opts.runId.trim()) {
            throw new CronCliError("--run-id must not be blank");
          }
          const res = await callGatewayFromCli("cron.runs", opts, {
            ...(opts.all ? { scope: "all" } : { id }),
            ...(typeof opts.runId === "string" && opts.runId.trim() ? { runId: opts.runId } : {}),
            ...(typeof opts.status === "string" ? { status: opts.status } : {}),
            ...(typeof opts.deliveryStatus === "string"
              ? { deliveryStatus: opts.deliveryStatus }
              : {}),
            ...(typeof opts.query === "string" ? { query: opts.query } : {}),
            ...(offset !== undefined ? { offset } : {}),
            ...(typeof opts.sort === "string" ? { sortDir: opts.sort } : {}),
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
      .command("stats")
      .description("Roll up cron run history into cost/efficiency stats (skipped vs ran vs tokens)")
      .option("--id <id>", "Limit stats to a single job id")
      .option("--limit <n>", "Max run-history entries per job (default 200)", "200")
      .option("--json", "Output JSON", false)
      .action(async (opts) => {
        try {
          const limit = parseStrictPositiveInteger(opts.limit ?? "200");
          if (limit === undefined) {
            throw new Error("Invalid --limit (must be a positive integer).");
          }
          const jobIds: string[] = [];
          if (typeof opts.id === "string" && opts.id.trim()) {
            jobIds.push(opts.id.trim());
          } else {
            let offset = 0;
            for (let page = 0; page < CRON_SHOW_LOOKUP_MAX_PAGES; page += 1) {
              if (jobIds.length >= CRON_STATS_MAX_JOBS) {
                break;
              }
              const res = await callGatewayFromCli("cron.list", opts, {
                includeDisabled: true,
                limit: CRON_SHOW_PAGE_SIZE,
                offset,
              });
              const listed = readGatewayShape<{
                jobs?: CronJob[];
                hasMore?: boolean;
                nextOffset?: number | null;
              }>(res);
              for (const job of listed.jobs ?? []) {
                jobIds.push(job.id);
                if (jobIds.length >= CRON_STATS_MAX_JOBS) {
                  break;
                }
              }
              if (jobIds.length >= CRON_STATS_MAX_JOBS) {
                break;
              }
              if (!listed.hasMore || typeof listed.nextOffset !== "number") {
                break;
              }
              if (listed.nextOffset <= offset) {
                break;
              }
              offset = listed.nextOffset;
            }
          }

          const perJob: Array<{ jobId: string; rollup: CronRunCostRollup }> = [];
          for (const jobId of jobIds) {
            const pageRaw = await callGatewayFromCli("cron.runs", opts, {
              id: jobId,
              limit,
            });
            const page = readGatewayShape<{ entries?: CronRunLogEntry[] }>(pageRaw);
            const rollup = rollupCronRunCost(page.entries ?? []);
            if (rollup.totalRuns > 0) {
              perJob.push({ jobId, rollup });
            }
          }

          const fleet = mergeCronRunCostRollups(perJob.map((p) => p.rollup));
          if (opts.json) {
            printCronJson({ fleet, jobs: perJob });
            return;
          }
          defaultRuntime.log(
            `Cron cost stats (last ${limit} runs/job; max ${CRON_STATS_MAX_JOBS} jobs without --id):`,
          );
          defaultRuntime.log(`  FLEET  ${formatCronRunCostRollup(fleet)}`);
          for (const { jobId, rollup } of perJob
            .slice()
            .toSorted((a, b) => b.rollup.skipped - a.rollup.skipped)) {
            defaultRuntime.log(`  ${jobId}  ${formatCronRunCostRollup(rollup)}`);
          }
        } catch (err) {
          handleCronCliError(err);
        }
      }),
  );

  addGatewayClientOptions(
    createCronOutputCommand(cron, "run")
      .description("Run an automation now (debug)")
      .argument("<id>", "Job id")
      .option("--due", "Run only when due (default behavior in older versions)", false)
      .option("--wait", "Wait for the queued run to finish", false)
      .option(
        "--wait-timeout <duration>",
        "Maximum time to wait for --wait",
        CRON_RUN_WAIT_TIMEOUT_DEFAULT,
      )
      .option(
        "--poll-interval <duration>",
        "Polling interval for --wait",
        CRON_RUN_WAIT_POLL_INTERVAL_DEFAULT,
      )
      .action(async (idArg, opts, command) => {
        try {
          const id = requireCronJobId(idArg);
          let waitTimeoutMs = 0;
          let pollIntervalMs = 0;
          if (opts.wait) {
            waitTimeoutMs = parseCronRunWaitDuration(opts.waitTimeout);
            pollIntervalMs = parseCronRunWaitDuration(opts.pollInterval);
            if (pollIntervalMs <= 0) {
              throw new CronCliError("invalid --poll-interval");
            }
          }
          if (command.getOptionValueSource("timeout") === "default") {
            opts.timeout = "600000";
          }
          const res = await callGatewayFromCli("cron.run", opts, {
            id,
            mode: opts.due ? "due" : "force",
          });
          const result = readGatewayShape<CronRunCommandResult | undefined>(res);
          if (opts.wait && result?.ok && result.enqueued) {
            if (!result.runId) {
              throw new Error("cron run did not return a runId to wait for");
            }
            const run = await waitForCronRunCompletion({
              opts,
              jobId: id,
              runId: result.runId,
              timeoutMs: waitTimeoutMs,
              pollIntervalMs,
            });
            const completionStatus =
              run.completionStatus ??
              resolveCronCompletionStatus({
                status: run.status,
                delivered: run.delivered,
                deliveryStatus: run.deliveryStatus,
              });
            const completedRun = { ...run, completionStatus };
            printCronJson({
              ...res,
              completed: true,
              status: run.status,
              completionStatus,
              run: completedRun,
            });
            exitCliAfterOutput(defaultRuntime, completionStatus === "succeeded" ? 0 : 1);
          }
          printCronJson(res);
          exitCliAfterOutput(defaultRuntime, result?.ok && (result.ran || result.enqueued) ? 0 : 1);
        } catch (err) {
          handleCronCliError(err);
        }
      }),
  );
}
