import { CronPattern } from "croner";
import type { CronJob } from "../../../api/types.ts";
import { i18n } from "../../../i18n/index.ts";
import { registerChatSessionEnglish } from "../../../i18n/locales/en-chat-session.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { nonCronSessionAutomationSchedule } from "./session-automation-schedule-non-cron.ts";

registerEnglishCatalog(registerChatSessionEnglish);

const selected = (values: number[]) => values.flatMap((value, index) => (value ? [index] : []));
const all = (values: number[]) => values.every(Boolean);

function yearRanges(years: number[]): string[] {
  const ranges: string[] = [];
  let first = years[0];
  let last = first;
  for (const year of years.slice(1)) {
    if (last !== undefined && year === last + 1) {
      last = year;
    } else {
      if (first !== undefined) {
        ranges.push(first === last ? String(first) : `${first}–${last}`);
      }
      first = last = year;
    }
  }
  if (first !== undefined) {
    ranges.push(first === last ? String(first) : `${first}–${last}`);
  }
  return ranges;
}

/** Presentation only. Croner owns the grammar, including named days and special dates. */
export function sessionAutomationSchedule(schedule: CronJob["schedule"]): string {
  if (schedule.kind !== "cron") {
    return nonCronSessionAutomationSchedule(schedule);
  }
  let pattern: CronPattern;
  try {
    pattern = new CronPattern(schedule.expr, schedule.tz);
  } catch {
    // Invalid schedules remain inspectable in the native editor, never guessed here.
    return t("chat.sessionAutomation.scheduleUnavailable");
  }
  const locale = i18n.getLocale();
  const list = (values: Array<string | number>) =>
    new Intl.ListFormat(locale, { type: "conjunction" }).format(values.map(String));
  const dayName = (day: number) =>
    new Intl.DateTimeFormat(locale, { weekday: "long", timeZone: "UTC" }).format(
      Date.UTC(2024, 0, 7 + day),
    );
  const minutes = selected(pattern.minute);
  const hours = selected(pattern.hour);
  const seconds = selected(pattern.second);
  const weekdays = selected(pattern.dayOfWeek);
  const ordinaryDays = pattern.dayOfWeek.every((value) => value === 0 || value === 63);
  const unrestrictedDate =
    pattern.starDOM && pattern.starDOW && all(pattern.month) && pattern.starYear;
  const hour = hours[0];
  const minute = minutes[0];
  const hourStep = hours[1];
  const regularHours =
    hour === 0 &&
    hourStep !== undefined &&
    24 % hourStep === 0 &&
    hours.length === 24 / hourStep &&
    hours.every((value, index) => value === index * hourStep);
  let time: string;
  if (
    seconds.length === 1 &&
    seconds[0] === 0 &&
    minutes.length === 1 &&
    hours.length === 1 &&
    hour !== undefined &&
    minute !== undefined
  ) {
    time = t("chat.sessionAutomation.atTime", {
      time: new Intl.DateTimeFormat(locale, {
        hour: "numeric",
        minute: "2-digit",
        timeZone: "UTC",
      }).format(Date.UTC(2024, 0, 1, hour, minute)),
    });
  } else if (seconds.length === 1 && seconds[0] === 0 && all(pattern.hour)) {
    const step = minutes[1];
    const regular =
      minutes[0] === 0 &&
      step !== undefined &&
      60 % step === 0 &&
      minutes.length === 60 / step &&
      minutes.every((value, index) => value === index * step);
    time = all(pattern.minute)
      ? t("chat.sessionAutomation.everyMinute")
      : minutes.length === 1 && minutes[0] === 0
        ? t("chat.sessionAutomation.everyHour")
        : regular
          ? t("chat.sessionAutomation.everyMinutes", { count: String(step) })
          : t("chat.sessionAutomation.hourMinutes", { minutes: list(minutes) });
  } else if (
    seconds.length === 1 &&
    seconds[0] === 0 &&
    minutes.length === 1 &&
    minute === 0 &&
    regularHours
  ) {
    time = t("chat.sessionAutomation.everyHours", { count: String(hourStep) });
  } else if (all(pattern.second) && all(pattern.minute) && all(pattern.hour)) {
    time = t("chat.sessionAutomation.everySecond");
  } else {
    // Describe the actual selected clock fields; e.g. */7 is not a continuous 7-minute interval.
    time = t("chat.sessionAutomation.clockFields", {
      hours: all(pattern.hour) ? t("chat.sessionAutomation.everyHour") : list(hours),
      minutes: all(pattern.minute) ? t("chat.sessionAutomation.everyMinute") : list(minutes),
      seconds: all(pattern.second) ? t("chat.sessionAutomation.everySecond") : list(seconds),
    });
  }
  if (unrestrictedDate) {
    return hours.length === 1 && minutes.length === 1 && seconds.length === 1 && seconds[0] === 0
      ? `${t("chat.sessionAutomation.daily")} ${time}`
      : time;
  }
  const monthDays: string[] = [];
  if (!pattern.starDOM) {
    const days = selected(pattern.day).map((day) => day + 1);
    if (days.length) {
      monthDays.push(t("chat.sessionAutomation.monthDays", { days: list(days) }));
    }
    if (pattern.lastDayOfMonth) {
      monthDays.push(t("chat.sessionAutomation.lastDay"));
    }
    if (pattern.lastWeekday) {
      monthDays.push(t("chat.sessionAutomation.lastWeekday"));
    }
    for (const day of selected(pattern.nearestWeekdays)) {
      monthDays.push(t("chat.sessionAutomation.nearestWeekday", { day: String(day + 1) }));
    }
  }
  const weekDays: string[] = [];
  if (!pattern.starDOW) {
    if (ordinaryDays && weekdays.join(",") === "1,2,3,4,5") {
      weekDays.push(t("chat.sessionAutomation.weekdays"));
    } else {
      for (const day of weekdays) {
        const occurrences = pattern.dayOfWeek[day] ?? 0;
        if (occurrences === 63) {
          weekDays.push(dayName(day));
        } else {
          for (let index = 0; index < 6; index++) {
            if (occurrences & (1 << index)) {
              weekDays.push(
                t("chat.sessionAutomation.monthWeekday", {
                  occurrence: t(`chat.sessionAutomation.occurrence${index + 1}`),
                  day: dayName(day),
                }),
              );
            }
          }
        }
      }
    }
  }
  const days =
    monthDays.length && weekDays.length
      ? t(
          pattern.useAndLogic
            ? "chat.sessionAutomation.bothDays"
            : "chat.sessionAutomation.eitherDays",
          {
            monthDays: list(monthDays),
            weekDays: list(weekDays),
          },
        )
      : list([...monthDays, ...weekDays]);
  const parts = [[days, time].filter(Boolean).join(" ")];
  if (!all(pattern.month)) {
    parts.push(
      t("chat.sessionAutomation.inMonths", {
        months: list(
          selected(pattern.month).map((month) =>
            new Intl.DateTimeFormat(locale, { month: "long", timeZone: "UTC" }).format(
              Date.UTC(2024, month, 1),
            ),
          ),
        ),
      }),
    );
  }
  if (!pattern.starYear) {
    parts.push(
      t("chat.sessionAutomation.inYears", { years: list(yearRanges(selected(pattern.year))) }),
    );
  }
  return parts.filter(Boolean).join(" · ");
}
