import { resolveExactDurationParts } from "../../../src/infra/format-time/format-duration-exact.ts";
import type { CronJob, GatewaySessionRow } from "../api/types.ts";
import { t } from "../i18n/index.ts";
import { registerCronScheduleEnglish } from "../i18n/locales/en-cron-schedule.ts";
import { resolveCronJobLastRunStatus } from "../lib/cron-status.ts";
import {
  formatDateMs,
  formatRelativeTimestamp,
  formatUnit,
  formatMs,
  formatUnknownText,
} from "../lib/format.ts";
import { resolveSessionContextLimit } from "./sessions/context-budget.ts";

registerCronScheduleEnglish();

export function formatNextRun(ms?: number | null) {
  if (!ms) {
    return t("common.na");
  }
  const weekday = formatDateMs(ms, { weekday: "short" });
  if (weekday === t("common.na")) {
    return weekday;
  }
  return `${weekday}, ${formatMs(ms)} (${formatRelativeTimestamp(ms)})`;
}

export function formatSessionTokens(row: GatewaySessionRow) {
  if (row.totalTokens == null) {
    return t("common.na");
  }
  const total = row.totalTokens ?? 0;
  const ctx = resolveSessionContextLimit(row).tokens;
  return ctx ? `${total} / ${ctx}` : String(total);
}

export function formatEventPayload(payload: unknown): string {
  if (payload == null) {
    return "";
  }
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return formatUnknownText(payload);
  }
}

export function formatCronState(job: CronJob) {
  const state = job.state ?? {};
  const next = state.nextRunAtMs ? formatMs(state.nextRunAtMs) : t("common.na");
  const last = state.lastRunAtMs ? formatMs(state.lastRunAtMs) : t("common.na");
  const status = resolveCronJobLastRunStatus(job);
  return t("cron.job.state", { status, next, last });
}

export function formatCronSchedule(job: Pick<CronJob, "schedule">) {
  const s = job.schedule;
  if (s.kind === "at") {
    const atMs = Date.parse(s.at);
    return t("cron.scheduleLabel.at", { time: Number.isFinite(atMs) ? formatMs(atMs) : s.at });
  }
  if (s.kind === "every") {
    const duration = resolveExactDurationParts(s.everyMs)?.map(formatUnit).join(" ");
    return t("cron.scheduleLabel.every", { duration: duration ?? t("common.na") });
  }
  if (s.kind === "on-exit") {
    // on-exit jobs carry a watched command (+ optional cwd), not a cron expr;
    // without this branch they fall through and render "Cron undefined".
    return withCwd(t("cron.scheduleLabel.onExit", { command: s.command }), s.cwd);
  }
  if (s.kind === "event") {
    const name = typeof s.options.name === "string" ? s.options.name : s.source;
    return t("cron.scheduleLabel.event", { name });
  }
  if (s.kind === "stream") {
    return withCwd(t("cron.scheduleLabel.stream", { command: s.command.join(" ") }), s.cwd);
  }
  const value = t("cron.scheduleLabel.cron", { expr: s.expr });
  return s.tz ? t("cron.scheduleLabel.withTimeZone", { value, timeZone: s.tz }) : value;
}

function withCwd(value: string, cwd: string | undefined) {
  return cwd ? t("cron.scheduleLabel.withCwd", { value, cwd }) : value;
}

export function formatCronPayload(job: CronJob) {
  const p = job.payload;
  // Newer Gateways name the stored kind; its agentTurn payload is only a placeholder.
  if (job.payloadSource?.kind === "pluginCommand") {
    return t("cron.job.pluginCommand", {
      command: job.payloadSource.command,
      plugin: job.payloadSource.pluginId,
    });
  }
  if (p.kind === "systemEvent") {
    return t("cron.job.system", { text: p.text });
  }
  if (p.kind === "command") {
    return t("cron.job.command", { command: p.argv.join(" ") });
  }
  if (p.kind === "script") {
    return t("cron.job.script", { script: p.script });
  }
  const base = t("cron.job.agent", { message: p.message });
  const delivery = job.delivery;
  if (delivery && delivery.mode !== "none") {
    const target =
      delivery.mode === "webhook"
        ? delivery.to
          ? ` (${delivery.to})`
          : ""
        : delivery.channel || delivery.to
          ? ` (${delivery.channel ?? "last"}${delivery.to ? ` -> ${delivery.to}` : ""})`
          : "";
    return `${base} · ${delivery.mode}${target}`;
  }
  return base;
}
