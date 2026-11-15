import { bucketRelativeTimeMs } from "@openclaw/normalization-core";
import { resolveExactDurationParts } from "../../../src/infra/format-time/format-duration-exact.ts";
import type { CronJob, GatewaySessionRow } from "../api/types.ts";
import { t } from "../i18n/index.ts";
import { registerCronScheduleEnglish } from "../i18n/locales/en-cron-schedule.ts";
import { isCronJobRunning, resolveCronJobLastRunStatus } from "../lib/cron-status.ts";
import {
  formatCompactMs,
  formatDateMs,
  formatRelativeTimestamp,
  formatTimeMs,
  formatUnit,
  formatMs,
  formatUnknownText,
} from "../lib/format.ts";
import { t as trackedT } from "./reactive/i18n.ts";
import { readVisibleTime } from "./reactive/visible-clock.ts";
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
  const next = state.nextRunAtMs ? formatCompactMs(state.nextRunAtMs) : t("common.na");
  const last = state.lastRunAtMs ? formatCompactMs(state.lastRunAtMs) : t("common.na");
  const status = resolveCronJobLastRunStatus(job);
  return t("cron.job.state", { status, next, last });
}

export function formatCronSchedule(job: Pick<CronJob, "schedule">) {
  const s = job.schedule;
  if (s.kind === "at") {
    const atMs = Date.parse(s.at);
    return t("cron.scheduleLabel.at", {
      time: Number.isFinite(atMs) ? formatCompactMs(atMs) : s.at,
    });
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

// Automation next-run timing shares this lazy cron presentation chunk; a separate
// shared chunk would grow every route's preload map.
/** Scheduler runtime facts; the authored occurrence never decides what happens next. */
export type AutomationNextRunFacts = {
  enabled: boolean;
  running: boolean;
  autoDisabled: boolean;
  waiting: boolean;
  /** Scheduler-owned deadline; null when nothing is queued. */
  nextRunAtMs: number | null;
};

export function cronJobNextRunFacts(job: CronJob): AutomationNextRunFacts {
  return {
    enabled: job.enabled,
    running: isCronJobRunning(job),
    autoDisabled: Boolean(job.state?.autoDisabled),
    waiting: Boolean(job.state?.admissionDeferred),
    nextRunAtMs: job.state?.nextRunAtMs ?? null,
  };
}

/** Wall-clock schedules repeat; a one-shot stays one-shot even after an explicit rearm. */
export function isRecurringSchedule(schedule: CronJob["schedule"]): boolean {
  return schedule.kind === "every" || schedule.kind === "cron";
}

const localDay = (date: Date) =>
  Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000;

function calendarTime(atMs: number, nowMs: number): string {
  const at = new Date(atMs);
  const now = new Date(nowMs);
  const days = localDay(at) - localDay(now);
  const time = formatTimeMs(atMs);
  if (days === 0) {
    return trackedT("cron.scheduleLabel.todayAt", { time });
  }
  if (days === 1) {
    return trackedT("cron.scheduleLabel.tomorrowAt", { time });
  }
  const day = formatDateMs(atMs, {
    month: "short",
    day: "numeric",
    ...(at.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
  return trackedT("cron.scheduleLabel.dateAt", { day, time });
}

/** Countdown first, then the same deadline as local calendar time. */
function formatAutomationNextRun(facts: AutomationNextRunFacts, nowMs: number): string {
  if (facts.running) {
    return trackedT("cron.scheduleLabel.running");
  }
  if (facts.autoDisabled) {
    return trackedT("cron.scheduleLabel.noRun");
  }
  if (!facts.enabled) {
    return trackedT("cron.scheduleLabel.paused");
  }
  if (facts.waiting) {
    return trackedT("cron.scheduleLabel.waiting");
  }
  if (facts.nextRunAtMs === null) {
    return trackedT("cron.scheduleLabel.noRun");
  }
  const remainingMs = facts.nextRunAtMs - nowMs;
  // A passed deadline that has not started is due, never a negative or invented countdown.
  if (remainingMs <= 0) {
    return trackedT("cron.scheduleLabel.due");
  }
  const { value, unit } = bucketRelativeTimeMs(remainingMs);
  const countdown = formatUnit({
    value: Math.max(1, value),
    unit,
    // "2 min" scans faster than "2 minutes"; "18 hr" reads worse than "18 hours".
    unitDisplay: unit === "second" || unit === "minute" ? "short" : "long",
  });
  return trackedT("cron.scheduleLabel.nextIn", {
    countdown,
    when: calendarTime(facts.nextRunAtMs, nowMs),
  });
}

/** Tracked reader: ticks every second near the deadline and every 30 seconds otherwise. */
export function readAutomationNextRun(facts: AutomationNextRunFacts): string {
  const near = facts.nextRunAtMs !== null && facts.nextRunAtMs - Date.now() < 120_000;
  return formatAutomationNextRun(facts, readVisibleTime(near ? 1_000 : 30_000));
}
