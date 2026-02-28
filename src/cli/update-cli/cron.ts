import type { Command } from "commander";
import type { CronJob } from "../../cron/types.js";
import { danger, success } from "../../globals.js";
import { defaultRuntime } from "../../runtime.js";
import { formatDocsLink } from "../../terminal/links.js";
import { theme } from "../../terminal/theme.js";
import { parseDurationMs } from "../cron-cli/shared.js";
import type { GatewayRpcOpts } from "../gateway-rpc.js";
import { addGatewayClientOptions, callGatewayFromCli } from "../gateway-rpc.js";

/** The well-known name for the automatic update cron job. */
export const UPDATE_CRON_JOB_NAME = "openclaw-auto-update";

/** Default cron schedule: daily at 4am */
const DEFAULT_CRON_SCHEDULE = "0 4 * * *";

interface EnableOptions extends GatewayRpcOpts {
  schedule?: string;
  every?: string;
  channel?: string;
  json?: boolean;
}

interface StatusOptions extends GatewayRpcOpts {
  json?: boolean;
}

/**
 * Build the system event text for the update cron job.
 * This runs `openclaw update` with optional channel flag.
 */
function buildUpdateCommand(channel?: string): string {
  const parts = ["openclaw update --yes"];
  if (channel) {
    parts.push(`--channel ${channel}`);
  }
  return parts.join(" ");
}

/**
 * Try to delete an existing update cron job (ignore errors if not found).
 */
async function deleteExistingJob(opts: GatewayRpcOpts): Promise<void> {
  try {
    await callGatewayFromCli("cron.delete", opts, { name: UPDATE_CRON_JOB_NAME });
  } catch {
    // Ignore - job may not exist
  }
}

async function enableUpdateCron(opts: EnableOptions): Promise<void> {
  try {
    // Remove existing job first (idempotent)
    await deleteExistingJob(opts);

    // Determine schedule
    const schedule = (() => {
      if (opts.every) {
        const everyMs = parseDurationMs(opts.every);
        if (!everyMs) {
          throw new Error("Invalid --every; use e.g. 12h, 1d");
        }
        return { kind: "every" as const, everyMs };
      }
      const expr = opts.schedule || DEFAULT_CRON_SCHEDULE;
      return { kind: "cron" as const, expr };
    })();

    // Build the update command
    const commandText = buildUpdateCommand(opts.channel);

    // Create the cron job
    const params = {
      name: UPDATE_CRON_JOB_NAME,
      description: "Automatic OpenClaw updates",
      enabled: true,
      sessionTarget: "main" as const,
      wakeMode: "now" as const,
      schedule,
      payload: {
        kind: "systemEvent" as const,
        text: commandText,
      },
    };

    const res = await callGatewayFromCli("cron.add", opts, params);

    if (opts.json) {
      defaultRuntime.log(JSON.stringify({ enabled: true, ...res }, null, 2));
    } else {
      const scheduleDesc =
        schedule.kind === "every" ? `every ${opts.every}` : `schedule: ${schedule.expr}`;
      defaultRuntime.log(success(`Automatic updates enabled (${scheduleDesc})`));
      if (opts.channel) {
        defaultRuntime.log(theme.muted(`Update channel: ${opts.channel}`));
      }
    }
  } catch (err) {
    defaultRuntime.error(danger(String(err)));
    defaultRuntime.exit(1);
  }
}

async function disableUpdateCron(opts: GatewayRpcOpts & { json?: boolean }): Promise<void> {
  try {
    await callGatewayFromCli("cron.delete", opts, { name: UPDATE_CRON_JOB_NAME });

    if (opts.json) {
      defaultRuntime.log(JSON.stringify({ enabled: false }, null, 2));
    } else {
      defaultRuntime.log(success("Automatic updates disabled"));
    }
  } catch (err) {
    const msg = String(err);
    if (msg.includes("not found") || msg.includes("Not found")) {
      if (opts.json) {
        defaultRuntime.log(JSON.stringify({ enabled: false, wasConfigured: false }, null, 2));
      } else {
        defaultRuntime.log(theme.muted("Automatic updates not configured"));
      }
    } else {
      defaultRuntime.error(danger(msg));
      defaultRuntime.exit(1);
    }
  }
}

async function showUpdateCronStatus(opts: StatusOptions): Promise<void> {
  try {
    const res = (await callGatewayFromCli("cron.list", opts, {
      includeDisabled: true,
    })) as { jobs?: CronJob[] } | null;

    const jobs = res?.jobs ?? [];
    const updateJob = jobs.find((j) => j.name === UPDATE_CRON_JOB_NAME);

    if (opts.json) {
      defaultRuntime.log(
        JSON.stringify(
          {
            enabled: Boolean(updateJob?.enabled),
            configured: Boolean(updateJob),
            job: updateJob ?? null,
          },
          null,
          2,
        ),
      );
      return;
    }

    if (!updateJob) {
      defaultRuntime.log(`${theme.heading("Automatic Updates:")} ${theme.muted("Disabled")}`);
      defaultRuntime.log(
        theme.muted(
          `\nRun ${theme.command("openclaw update cron enable")} to enable automatic updates.`,
        ),
      );
      return;
    }

    const statusText = updateJob.enabled ? theme.success("Enabled") : theme.warning("Paused");
    defaultRuntime.log(`${theme.heading("Automatic Updates:")} ${statusText}`);

    // Show schedule
    const schedule = updateJob.schedule;
    if (schedule) {
      if ("expr" in schedule && schedule.expr) {
        defaultRuntime.log(`${theme.muted("Schedule:")} ${schedule.expr}`);
      } else if ("everyMs" in schedule && schedule.everyMs) {
        const hours = Math.round(schedule.everyMs / 3600000);
        defaultRuntime.log(`${theme.muted("Schedule:")} every ${hours}h`);
      }
    }

    // Show next run
    if (updateJob.nextRun) {
      const nextRun = new Date(updateJob.nextRun);
      defaultRuntime.log(`${theme.muted("Next run:")} ${nextRun.toLocaleString()}`);
    }

    // Show last run
    if (updateJob.lastRun) {
      const lastRun = new Date(updateJob.lastRun);
      defaultRuntime.log(`${theme.muted("Last run:")} ${lastRun.toLocaleString()}`);
    }
  } catch (err) {
    defaultRuntime.error(danger(String(err)));
    defaultRuntime.exit(1);
  }
}

export function registerUpdateCronCommand(parent: Command): void {
  const cron = parent
    .command("cron")
    .description("Manage automatic update scheduling")
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}
  ${theme.command("openclaw update cron enable")}           ${theme.muted("# Enable daily updates at 4am")}
  ${theme.command("openclaw update cron enable --every 12h")} ${theme.muted("# Update every 12 hours")}
  ${theme.command("openclaw update cron enable --schedule '0 2 * * 0'")} ${theme.muted("# Weekly on Sunday 2am")}
  ${theme.command("openclaw update cron disable")}          ${theme.muted("# Disable automatic updates")}
  ${theme.command("openclaw update cron status")}           ${theme.muted("# Show current status")}

${theme.muted("Docs:")} ${formatDocsLink("/cli/update", "docs.openclaw.ai/cli/update")}`,
    );

  addGatewayClientOptions(
    cron
      .command("enable")
      .description("Enable automatic updates via cron")
      .option(
        "--schedule <cron>",
        `Cron expression (default: "${DEFAULT_CRON_SCHEDULE}" = daily 4am)`,
      )
      .option("--every <duration>", "Run every duration (e.g. 12h, 1d)")
      .option("--channel <stable|beta|dev>", "Update channel to use")
      .option("--json", "Output JSON", false)
      .action(async (opts: EnableOptions) => {
        if (opts.schedule && opts.every) {
          defaultRuntime.error(danger("Choose either --schedule or --every, not both"));
          defaultRuntime.exit(1);
          return;
        }
        await enableUpdateCron(opts);
      }),
  );

  addGatewayClientOptions(
    cron
      .command("disable")
      .description("Disable automatic updates")
      .option("--json", "Output JSON", false)
      .action(async (opts: GatewayRpcOpts & { json?: boolean }) => {
        await disableUpdateCron(opts);
      }),
  );

  addGatewayClientOptions(
    cron
      .command("status")
      .description("Show automatic update status")
      .option("--json", "Output JSON", false)
      .action(async (opts: StatusOptions) => {
        await showUpdateCronStatus(opts);
      }),
  );
}
