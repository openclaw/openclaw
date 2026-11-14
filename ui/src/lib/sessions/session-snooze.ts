import type { GatewaySessionRow } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import { formatDateTimeMs, formatTimeMs } from "../format.ts";

type SnoozeRow = Pick<GatewaySessionRow, "snoozedUntil">;

export function isSessionSnoozed(row: SnoozeRow, nowMs: number): boolean {
  return row.snoozedUntil !== undefined && row.snoozedUntil > nowMs;
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

/** Wake label relative to today. `dayOnly` drops the clock time beyond today for
 *  compact rows, which keep the full label in their tooltip. */
export function formatSessionSnoozeWakeTime(
  snoozedUntil: number,
  now = new Date(),
  dayOnly = false,
): string {
  const wake = new Date(snoozedUntil);
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  if (wake.toDateString() === day.toDateString()) {
    return formatTimeMs(snoozedUntil);
  }
  day.setDate(day.getDate() + 1);
  if (wake.toDateString() === day.toDateString()) {
    return dayOnly
      ? t("sessionsView.snoozeTomorrow")
      : t("sessionsView.snoozeTomorrowTime", { time: formatTimeMs(snoozedUntil) });
  }
  const nextWeek = new Date(now);
  nextWeek.setDate(nextWeek.getDate() + 7);
  return formatDateTimeMs(snoozedUntil, {
    ...(wake.getTime() > now.getTime() && wake.getTime() <= nextWeek.getTime()
      ? { weekday: "short" }
      : { month: "short", day: "numeric" }),
    ...(dayOnly ? {} : { hour: "numeric", minute: "2-digit" }),
  });
}
