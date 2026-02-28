import type { Command } from "commander";
import { isGatewayTransportTimeoutError } from "../../gateway/call.js";
import { danger } from "../../globals.js";
import { defaultRuntime } from "../../runtime.js";
import { addGatewayClientOptions, callGatewayFromCli } from "../gateway-rpc.js";
import { warnIfCronSchedulerDisabled } from "./shared.js";

const CRON_RUN_RECONCILE_RECENT_MS = 2 * 60_000;

function isCronRunTimeoutLikeError(err: unknown): boolean {
  if (isGatewayTransportTimeoutError(err)) {
    return true;
  }
  const text = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return /gateway timeout after/i.test(text);
}

async function reconcileCronRunTimeout(params: { id: string; opts: Record<string, unknown> }) {
  const startedAt = Date.now();
  try {
    const runsPayload = (await callGatewayFromCli("cron.runs", params.opts, {
      id: params.id,
      limit: 1,
    })) as { entries?: Array<{ ts?: number; runId?: string; status?: string; summary?: string }> };
    const latest = Array.isArray(runsPayload.entries) ? runsPayload.entries[0] : undefined;
    const latestTs =
      latest && typeof latest.ts === "number" && Number.isFinite(latest.ts) ? latest.ts : null;
    const recent =
      latestTs !== null && Math.abs(startedAt - latestTs) <= CRON_RUN_RECONCILE_RECENT_MS;
    return {
      state: recent ? "recent-run-observed" : "pending-or-older-run",
      checkedAt: Date.now(),
      latest: latest ?? null,
      windowMs: CRON_RUN_RECONCILE_RECENT_MS,
    };
  } catch (reconcileErr) {
    return {
      state: "reconcile-failed",
      checkedAt: Date.now(),
      error: String(reconcileErr),
    };
  }
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
      .action(async (id, opts) => {
        try {
          const res = await callGatewayFromCli("cron.run", opts, {
            id,
            mode: opts.due ? "due" : "force",
          });
          defaultRuntime.log(JSON.stringify(res, null, 2));
        } catch (err) {
          if (isCronRunTimeoutLikeError(err)) {
            const mode = opts.due ? "due" : "force";
            const reconciliation = await reconcileCronRunTimeout({
              id: String(id),
              opts: opts as Record<string, unknown>,
            });
            defaultRuntime.log(
              JSON.stringify(
                {
                  ok: false,
                  accepted: true,
                  status: "transport-timeout",
                  errorType: "GATEWAY_TRANSPORT_TIMEOUT",
                  jobId: String(id),
                  mode,
                  note: "Request may have been accepted; reconciled once via cron.runs.",
                  reconciliation,
                },
                null,
                2,
              ),
            );
            return;
          }
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        }
      }),
  );
}
