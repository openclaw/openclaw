import { listChannelPlugins } from "../../channels/plugins/index.js";
import { parseAbsoluteTimeMs } from "../../cron/parse.js";
import { resolveCronStaggerMs } from "../../cron/stagger.js";
import type { CronJob, CronSchedule } from "../../cron/types.js";
import { formatDurationHuman } from "../../infra/format-time/format-duration.ts";
import { defaultRuntime } from "../../runtime.js";
import { colorize, isRich, theme } from "../../terminal/theme.js";
import type { GatewayRpcOpts } from "../gateway-rpc.js";
import { callGatewayFromCli } from "../gateway-rpc.js";

export const getCronChannelOptions = () =>
  ["last", ...listChannelPlugins().map((plugin) => plugin.id)].join("|");

export async function warnIfCronSchedulerDisabled(opts: GatewayRpcOpts) {
  try {
    const res = (await callGatewayFromCli("cron.status", opts, {})) as {
      enabled?: boolean;
      storePath?: string;
    };
    if (res?.enabled === true) {
      return;
    }
    const store = typeof res?.storePath === "string" ? res.storePath : "";
    defaultRuntime.error(
      [
        "warning: cron scheduler is disabled in the Gateway; jobs are saved but will not run automatically.",
        "Re-enable with `cron.enabled: true` (or remove `cron.enabled: false`) and restart the Gateway.",
        store ? `store: ${store}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  } catch {
    // Ignore status failures (older gateway, offline, etc.)
  }
}

export function parseDurationMs(input: string): number | null {
  const raw = input.trim();
  if (!raw) {
    return null;
  }
  const match = raw.match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/i);
  if (!match) {
    return null;
  }
  const n = Number.parseFloat(match[1] ?? "");
  if (!Number.isFinite(n) || n <= 0) {
    return null;
  }
  const unit = (match[2] ?? "").toLowerCase();
  const factor =
    unit === "ms"
      ? 1
      : unit === "s"
        ? 1000
        : unit === "m"
          ? 60_000
          : unit === "h"
            ? 3_600_000
            : 86_400_000;
  return Math.floor(n * factor);
}

export function parseAt(input: string): string | null {
  const raw = input.trim();
  if (!raw) {
    return null;
  }
  const absolute = parseAbsoluteTimeMs(raw);
  if (absolute !== null) {
    return new Date(absolute).toISOString();
  }
  const dur = parseDurationMs(raw);
  if (dur !== null) {
    return new Date(Date.now() + dur).toISOString();
  }
  return null;
}

const CRON_ID_PAD = 36;
const CRON_NAME_PAD = 24;
const CRON_SCHEDULE_PAD = 32;
const CRON_NEXT_PAD = 10;
const CRON_LAST_PAD = 10;
const CRON_STATUS_PAD = 9;
const CRON_TARGET_PAD = 9;
const CRON_AGENT_PAD = 10;
const CRON_MODEL_PAD = 20;

const pad = (value: string, width: number) => value.padEnd(width);

const truncate = (value: string, width: number) => {
  if (value.length <= width) {
    return value;
  }
  if (width <= 3) {
    return value.slice(0, width);
  }
  return `${value.slice(0, width - 3)}...`;
};

const formatIsoMinute = (iso: string) => {
  const parsed = parseAbsoluteTimeMs(iso);
  const d = new Date(parsed ?? NaN);
  if (Number.isNaN(d.getTime())) {
    return "-";
  }
  const isoStr = d.toISOString();
  return `${isoStr.slice(0, 10)} ${isoStr.slice(11, 16)}Z`;
};

const formatSpan = (ms: number) => {
  if (ms < 60_000) {
    return "<1m";
  }
  if (ms < 3_600_000) {
    return `${Math.round(ms / 60_000)}m`;
  }
  if (ms < 86_400_000) {
    return `${Math.round(ms / 3_600_000)}h`;
  }
  return `${Math.round(ms / 86_400_000)}d`;
};

const formatRelative = (ms: number | null | undefined, nowMs: number) => {
  if (!ms) {
    return "-";
  }
  const delta = ms - nowMs;
  const label = formatSpan(Math.abs(delta));
  return delta >= 0 ? `in ${label}` : `${label} ago`;
};

const formatSchedule = (schedule: CronSchedule) => {
  if (schedule.kind === "at") {
    return `at ${formatIsoMinute(schedule.at)}`;
  }
  if (schedule.kind === "every") {
    return `every ${formatDurationHuman(schedule.everyMs)}`;
  }
  const base = schedule.tz ? `cron ${schedule.expr} @ ${schedule.tz}` : `cron ${schedule.expr}`;
  const staggerMs = resolveCronStaggerMs(schedule);
  if (staggerMs <= 0) {
    return `${base} (exact)`;
  }
  return `${base} (stagger ${formatDurationHuman(staggerMs)})`;
};

const formatStatus = (job: CronJob) => {
  if (!job.enabled) {
    return "disabled";
  }
  if (job.state.runningAtMs) {
    return "running";
  }
  return job.state.lastStatus ?? "idle";
};

export function printCronList(jobs: CronJob[], runtime = defaultRuntime) {
  if (jobs.length === 0) {
    runtime.log("No cron jobs.");
    return;
  }

  const rich = isRich();
  const header = [
    pad("ID", CRON_ID_PAD),
    pad("Name", CRON_NAME_PAD),
    pad("Schedule", CRON_SCHEDULE_PAD),
    pad("Next", CRON_NEXT_PAD),
    pad("Last", CRON_LAST_PAD),
    pad("Status", CRON_STATUS_PAD),
    pad("Target", CRON_TARGET_PAD),
    pad("Agent ID", CRON_AGENT_PAD),
    pad("Model", CRON_MODEL_PAD),
  ].join(" ");

  runtime.log(rich ? theme.heading(header) : header);
  const now = Date.now();

  for (const job of jobs) {
    const idLabel = pad(job.id, CRON_ID_PAD);
    const nameLabel = pad(truncate(job.name, CRON_NAME_PAD), CRON_NAME_PAD);
    const scheduleLabel = pad(
      truncate(formatSchedule(job.schedule), CRON_SCHEDULE_PAD),
      CRON_SCHEDULE_PAD,
    );
    const nextLabel = pad(
      job.enabled ? formatRelative(job.state.nextRunAtMs, now) : "-",
      CRON_NEXT_PAD,
    );
    const lastLabel = pad(formatRelative(job.state.lastRunAtMs, now), CRON_LAST_PAD);
    const statusRaw = formatStatus(job);
    const statusLabel = pad(statusRaw, CRON_STATUS_PAD);
    const targetLabel = pad(job.sessionTarget ?? "-", CRON_TARGET_PAD);
    const agentLabel = pad(truncate(job.agentId ?? "-", CRON_AGENT_PAD), CRON_AGENT_PAD);
    const modelLabel = pad(
      truncate(
        (job.payload.kind === "agentTurn" ? job.payload.model : undefined) ?? "-",
        CRON_MODEL_PAD,
      ),
      CRON_MODEL_PAD,
    );

    const coloredStatus = (() => {
      if (statusRaw === "ok") {
        return colorize(rich, theme.success, statusLabel);
      }
      if (statusRaw === "error") {
        return colorize(rich, theme.error, statusLabel);
      }
      if (statusRaw === "running") {
        return colorize(rich, theme.warn, statusLabel);
      }
      if (statusRaw === "skipped") {
        return colorize(rich, theme.muted, statusLabel);
      }
      return colorize(rich, theme.muted, statusLabel);
    })();

    const coloredTarget =
      job.sessionTarget === "isolated"
        ? colorize(rich, theme.accentBright, targetLabel)
        : colorize(rich, theme.accent, targetLabel);
    const coloredAgent = job.agentId
      ? colorize(rich, theme.info, agentLabel)
      : colorize(rich, theme.muted, agentLabel);

    const line = [
      colorize(rich, theme.accent, idLabel),
      colorize(rich, theme.info, nameLabel),
      colorize(rich, theme.info, scheduleLabel),
      colorize(rich, theme.muted, nextLabel),
      colorize(rich, theme.muted, lastLabel),
      coloredStatus,
      coloredTarget,
      coloredAgent,
      job.payload.kind === "agentTurn" && job.payload.model
        ? colorize(rich, theme.info, modelLabel)
        : colorize(rich, theme.muted, modelLabel),
    ].join(" ");

    runtime.log(line.trimEnd());
  }
}
