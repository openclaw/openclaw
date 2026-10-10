import type { GatewaySessionRow } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import { formatDateTimeMs, formatTimeMs } from "../format.ts";

type SnoozeRow = Pick<GatewaySessionRow, "snoozedUntil">;
type SnoozePreset = {
  id: "hour" | "three-hours" | "evening" | "tomorrow" | "next-week";
  snoozedUntil: number;
};

export function isSessionSnoozed(row: SnoozeRow, nowMs: number): boolean {
  return (
    typeof row.snoozedUntil === "number" &&
    Number.isFinite(row.snoozedUntil) &&
    row.snoozedUntil > nowMs
  );
}

export function resolveSessionSnoozePresets(now: Date): ReadonlyArray<SnoozePreset> {
  const hour = 60 * 60 * 1000;
  const presets: SnoozePreset[] = [
    { id: "hour", snoozedUntil: now.getTime() + hour },
    { id: "three-hours", snoozedUntil: now.getTime() + 3 * hour },
  ];
  const evening = new Date(now);
  evening.setHours(18, 0, 0, 0);
  if (evening.getTime() - now.getTime() > hour) {
    presets.push({ id: "evening", snoozedUntil: evening.getTime() });
  }
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  presets.push({ id: "tomorrow", snoozedUntil: tomorrow.getTime() });
  const nextMonday = new Date(now);
  nextMonday.setDate(nextMonday.getDate() + ((8 - nextMonday.getDay()) % 7 || 7));
  nextMonday.setHours(9, 0, 0, 0);
  if (nextMonday.getTime() !== tomorrow.getTime()) {
    presets.push({ id: "next-week", snoozedUntil: nextMonday.getTime() });
  }
  return presets;
}

export function nextSessionSnoozeWakeAt(rows: Iterable<SnoozeRow>, nowMs: number): number | null {
  let next: number | null = null;
  for (const row of rows) {
    if (isSessionSnoozed(row, nowMs) && (next === null || row.snoozedUntil! < next)) {
      next = row.snoozedUntil!;
    }
  }
  return next;
}

export function formatSessionSnoozeWakeTime(snoozedUntil: number, now = new Date()): string {
  const wake = new Date(snoozedUntil);
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  if (wake.toDateString() === day.toDateString()) {
    return formatTimeMs(snoozedUntil);
  }
  day.setDate(day.getDate() + 1);
  if (wake.toDateString() === day.toDateString()) {
    return t("sessionsView.snoozeTomorrowTime", { time: formatTimeMs(snoozedUntil) });
  }
  const nextWeek = new Date(now);
  nextWeek.setDate(nextWeek.getDate() + 7);
  return formatDateTimeMs(snoozedUntil, {
    ...(wake.getTime() > now.getTime() && wake.getTime() <= nextWeek.getTime()
      ? { weekday: "short" }
      : { month: "short", day: "numeric" }),
    hour: "numeric",
    minute: "2-digit",
  });
}
