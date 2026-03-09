import type { Command } from "commander";
import { CRON_BACKUP_CREATE_KIND, isCronBackupCreatePayload } from "../../cron/backup-payload.js";
import type { CronJob } from "../../cron/types.js";
import { defaultRuntime } from "../../runtime.js";
import { theme } from "../../terminal/theme.js";
import {
  handleCronCliError,
  parseAt,
  parseCronStaggerMs,
  parseDurationMs,
  printCronJson,
  printCronList,
  warnIfCronSchedulerDisabled,
} from "../cron-cli/shared.js";
import { addGatewayClientOptions, callGatewayFromCli } from "../gateway-rpc.js";
import { formatHelpExamples } from "../help-format.js";

const DEFAULT_BACKUP_SCHEDULE_MS = 24 * 60 * 60_000;
const DEFAULT_BACKUP_OUTPUT = "~/Backups/";

function resolveBackupScheduleJobs(rawJobs: unknown): CronJob[] {
  const jobs = (rawJobs as { jobs?: CronJob[] } | CronJob[] | null | undefined) ?? [];
  const list = Array.isArray(jobs) ? jobs : (jobs.jobs ?? []);
  return list.filter((job) => isCronBackupCreatePayload(job.payload));
}

function resolveBackupSchedule(opts: Record<string, unknown>) {
  const staggerRaw = typeof opts.stagger === "string" ? opts.stagger.trim() : "";
  const useExact = Boolean(opts.exact);
  if (staggerRaw && useExact) {
    throw new Error("Choose either --stagger or --exact, not both");
  }

  const at = typeof opts.at === "string" ? opts.at : "";
  const every = typeof opts.every === "string" ? opts.every : "";
  const cronExpr = typeof opts.cron === "string" ? opts.cron : "";
  const chosen = [Boolean(at), Boolean(every), Boolean(cronExpr)].filter(Boolean).length;
  if (chosen > 1) {
    throw new Error("Choose at most one schedule: --at, --every, or --cron");
  }
  if ((useExact || staggerRaw) && !cronExpr) {
    throw new Error("--stagger/--exact are only valid with --cron");
  }

  if (chosen === 0) {
    return { kind: "every" as const, everyMs: DEFAULT_BACKUP_SCHEDULE_MS };
  }
  if (at) {
    const atIso = parseAt(at);
    if (!atIso) {
      throw new Error("Invalid --at; use ISO time or duration like 20m");
    }
    return { kind: "at" as const, at: atIso };
  }
  if (every) {
    const everyMs = parseDurationMs(every);
    if (!everyMs) {
      throw new Error("Invalid --every; use e.g. 12h, 1d");
    }
    return { kind: "every" as const, everyMs };
  }
  return {
    kind: "cron" as const,
    expr: cronExpr,
    tz: typeof opts.tz === "string" && opts.tz.trim() ? opts.tz.trim() : undefined,
    staggerMs: parseCronStaggerMs({ staggerRaw, useExact }),
  };
}

export function registerBackupScheduleCommand(backup: Command) {
  const schedule = backup.command("schedule").description("Manage scheduled backup jobs");

  addGatewayClientOptions(
    schedule
      .command("add")
      .description("Schedule recurring or one-shot backups through the Gateway cron scheduler")
      .option("--name <name>", "Job name", "Scheduled backup")
      .option("--description <text>", "Optional description")
      .option("--disabled", "Create job disabled", false)
      .option("--at <when>", "Run once at time (ISO) or +duration (e.g. 20m)")
      .option("--every <duration>", "Run every duration (e.g. 12h, 1d)")
      .option("--cron <expr>", "Cron expression (5-field or 6-field with seconds)")
      .option("--tz <iana>", "Timezone for cron expressions (IANA)", "")
      .option("--stagger <duration>", "Cron stagger window (e.g. 30s, 5m)")
      .option("--exact", "Disable cron staggering (set stagger to 0)", false)
      .option(
        "--output <path>",
        'Archive path or destination directory (defaults to "~/Backups/")',
        DEFAULT_BACKUP_OUTPUT,
      )
      .option("--verify", "Verify the archive after writing it", false)
      .option("--only-config", "Back up only the active JSON config file", false)
      .option("--no-include-workspace", "Exclude workspace directories from the backup")
      .option("--json", "Output JSON", false)
      .addHelpText(
        "after",
        () =>
          `\n${theme.heading("Examples:")}\n${formatHelpExamples([
            [
              "openclaw backup schedule add",
              "Run a scheduled backup once per day and write archives into ~/Backups/.",
            ],
            [
              'openclaw backup schedule add --cron "0 3 * * *" --tz America/Los_Angeles',
              "Run a scheduled backup every day at 03:00 in the chosen timezone.",
            ],
            [
              "openclaw backup schedule add --every 12h --no-include-workspace",
              "Schedule a lighter backup that skips workspace directories.",
            ],
          ])}`,
      )
      .action(async (opts) => {
        try {
          const scheduleSpec = resolveBackupSchedule(opts as Record<string, unknown>);
          const name = typeof opts.name === "string" ? opts.name.trim() : "";
          if (!name) {
            throw new Error("--name is required");
          }

          const res = await callGatewayFromCli("cron.add", opts, {
            name,
            description:
              typeof opts.description === "string" && opts.description.trim()
                ? opts.description.trim()
                : undefined,
            enabled: !opts.disabled,
            deleteAfterRun: scheduleSpec.kind === "at" ? true : undefined,
            sessionTarget: "main",
            wakeMode: "now",
            schedule: scheduleSpec,
            payload: {
              kind: CRON_BACKUP_CREATE_KIND,
              output:
                typeof opts.output === "string" && opts.output.trim()
                  ? opts.output.trim()
                  : undefined,
              includeWorkspace: opts.includeWorkspace as boolean,
              onlyConfig: Boolean(opts.onlyConfig),
              verify: Boolean(opts.verify),
            },
          });
          printCronJson(res);
          await warnIfCronSchedulerDisabled(opts);
        } catch (err) {
          handleCronCliError(err);
        }
      }),
  );

  addGatewayClientOptions(
    schedule
      .command("list")
      .description("List scheduled backup jobs")
      .option("--json", "Output JSON", false)
      .action(async (opts) => {
        try {
          const res = await callGatewayFromCli("cron.list", opts, {
            includeDisabled: true,
          });
          const jobs = resolveBackupScheduleJobs(res);
          if (opts.json) {
            printCronJson({ jobs });
            return;
          }
          if (jobs.length === 0) {
            defaultRuntime.log("No scheduled backups.");
            return;
          }
          printCronList(jobs, defaultRuntime);
        } catch (err) {
          handleCronCliError(err);
        }
      }),
  );

  addGatewayClientOptions(
    schedule
      .command("remove")
      .description("Remove a scheduled backup job")
      .argument("<id>", "Backup job id")
      .option("--json", "Output JSON", false)
      .action(async (id, opts) => {
        try {
          const listed = await callGatewayFromCli("cron.list", opts, {
            includeDisabled: true,
          });
          const job = resolveBackupScheduleJobs(listed).find((entry) => entry.id === id);
          if (!job) {
            throw new Error(`unknown scheduled backup id: ${id}`);
          }
          const res = await callGatewayFromCli("cron.remove", opts, { id });
          if (opts.json) {
            printCronJson(res);
            return;
          }
          defaultRuntime.log(`Removed scheduled backup ${id}.`);
        } catch (err) {
          handleCronCliError(err);
        }
      }),
  );
}
