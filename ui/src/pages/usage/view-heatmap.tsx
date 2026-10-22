import { For } from "solid-js";
import { SettingsSection } from "../../components/solid/settings-ui.tsx";
import { t } from "../../lib/reactive/i18n.ts";
import { formatFullDate } from "./metrics.ts";
import type { CostDailyEntry } from "./types.ts";

type UsageHeatmapDay = {
  date: string;
  tokens: number;
  /** 0 = no activity, 1-4 = nonzero-quartile intensity buckets. */
  level: 0 | 1 | 2 | 3 | 4;
  /** An interrupted response that day leaves its recorded tokens as a lower bound. */
  partial: boolean;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_HEATMAP_DAYS = 52 * 7;

/** Interpret a YYYY-MM-DD label at UTC noon so day math never crosses DST edges. */
function dateToUtcNoon(date: string): number {
  return new Date(`${date}T12:00:00Z`).getTime();
}

function levelThresholds(values: number[]): [number, number, number] {
  const sorted = values.toSorted((a, b) => a - b);
  const pick = (ratio: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] ?? 0;
  return [pick(0.25), pick(0.5), pick(0.75)];
}

// Strict-less-than buckets put days at a quartile edge in the darker level;
// uniformly active ranges then read fully saturated instead of faint.
function levelFor(tokens: number, thresholds: [number, number, number]): UsageHeatmapDay["level"] {
  if (tokens <= 0) {
    return 0;
  }
  if (tokens < thresholds[0]) {
    return 1;
  }
  if (tokens < thresholds[1]) {
    return 2;
  }
  if (tokens < thresholds[2]) {
    return 3;
  }
  return 4;
}

/**
 * GitHub-style grid for the selected range, capped at its trailing 52 weeks.
 * Columns are Sunday-first; intensity buckets come from nonzero-day quartiles
 * so sparse and heavy ranges both spread across the palette.
 */
function buildUsageHeatmap(
  daily: readonly CostDailyEntry[],
  rangeStartDate: string,
  rangeEndDate: string,
) {
  const endMs = dateToUtcNoon(rangeEndDate);
  const startMs = Math.max(dateToUtcNoon(rangeStartDate), endMs - (MAX_HEATMAP_DAYS - 1) * DAY_MS);
  const tokensByDate = new Map(daily.map((entry) => [entry.date, entry.totalTokens]));
  const partialDates = new Set(
    daily.filter((entry) => entry.usageReport?.state === "unavailable").map((entry) => entry.date),
  );
  const nonZero = daily
    .filter((entry) => {
      const entryMs = dateToUtcNoon(entry.date);
      return entry.totalTokens > 0 && entryMs >= startMs && entryMs <= endMs;
    })
    .map((entry) => entry.totalTokens);
  const thresholds = levelThresholds(nonZero);

  const startWeekday = new Date(startMs).getUTCDay();
  const gridStartMs = startMs - startWeekday * DAY_MS;
  const monthFormat = new Intl.DateTimeFormat(undefined, { month: "short", timeZone: "UTC" });
  const weeks: Array<{ days: Array<UsageHeatmapDay | null> }> = [];
  const monthLabels: string[] = [];
  let previousMonth = -1;
  for (let weekMs = gridStartMs; weekMs <= endMs; weekMs += 7 * DAY_MS) {
    const days: Array<UsageHeatmapDay | null> = [];
    for (let weekday = 0; weekday < 7; weekday += 1) {
      const dayMs = weekMs + weekday * DAY_MS;
      if (dayMs < startMs || dayMs > endMs) {
        days.push(null);
        continue;
      }
      const date = new Date(dayMs).toISOString().slice(0, 10);
      const tokens = tokensByDate.get(date) ?? 0;
      days.push({
        date,
        tokens,
        level: levelFor(tokens, thresholds),
        partial: partialDates.has(date),
      });
    }
    weeks.push({ days });
    const firstVisibleDay = days.find((day): day is UsageHeatmapDay => day !== null);
    const firstVisibleMs = dateToUtcNoon(firstVisibleDay?.date ?? rangeEndDate);
    const month = new Date(firstVisibleMs).getUTCMonth();
    monthLabels.push(month === previousMonth ? "" : monthFormat.format(new Date(firstVisibleMs)));
    previousMonth = month;
  }
  return { weeks, monthLabels };
}

const HEATMAP_CELL = 11;
const HEATMAP_GAP = 3;
const HEATMAP_PITCH = HEATMAP_CELL + HEATMAP_GAP;
const HEATMAP_LEFT = 30;
const HEATMAP_TOP = 18;

// Fixed reference week (2024-01-01 is a Monday) for localized weekday labels.
const WEEKDAY_LABEL_ROWS = [
  { row: 1, utcDay: Date.UTC(2024, 0, 1) },
  { row: 3, utcDay: Date.UTC(2024, 0, 3) },
  { row: 5, utcDay: Date.UTC(2024, 0, 5) },
];

function renderHeatmapSvg(heatmap: ReturnType<typeof buildUsageHeatmap>) {
  const width = HEATMAP_LEFT + heatmap.weeks.length * HEATMAP_PITCH;
  const height = HEATMAP_TOP + 7 * HEATMAP_PITCH;
  const numberFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
  const weekdayFormat = new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    timeZone: "UTC",
  });
  return (
    <svg
      class="usage-heatmap__svg"
      viewBox={`0 0 ${width} ${height}`}
      style={{ "--usage-heatmap-width": `${width}px` }}
      role="group"
      aria-label={t("usage.heatmap.title")}
    >
      <For each={heatmap.monthLabels}>
        {(label, index) =>
          label ? (
            <text class="usage-heatmap__month" x={HEATMAP_LEFT + index() * HEATMAP_PITCH} y="10">
              {label}
            </text>
          ) : undefined
        }
      </For>
      <For each={WEEKDAY_LABEL_ROWS}>
        {({ row, utcDay }) => (
          <text
            class="usage-heatmap__weekday"
            x={HEATMAP_LEFT - 6}
            y={HEATMAP_TOP + row * HEATMAP_PITCH + HEATMAP_CELL - 2}
          >
            {weekdayFormat.format(new Date(utcDay))}
          </text>
        )}
      </For>
      <For each={heatmap.weeks}>
        {(week, weekIndex) => (
          <For each={week.days}>
            {(day, dayIndex) => {
              if (!day) {
                return undefined;
              }
              const tooltip = () =>
                `${formatFullDate(day.date)} · ${t("usage.heatmap.cellTokens", {
                  tokens: day.partial
                    ? t("usage.common.atLeast", { value: numberFormat.format(day.tokens) })
                    : numberFormat.format(day.tokens),
                })}`;
              return (
                <rect
                  class={["usage-heatmap__cell", `usage-heatmap__cell--l${day.level}`]}
                  x={HEATMAP_LEFT + weekIndex() * HEATMAP_PITCH}
                  y={HEATMAP_TOP + dayIndex() * HEATMAP_PITCH}
                  width={HEATMAP_CELL}
                  height={HEATMAP_CELL}
                  rx="2.5"
                  role="img"
                  data-tooltip={tooltip()}
                  aria-label={tooltip()}
                />
              );
            }}
          </For>
        )}
      </For>
    </svg>
  );
}

export function renderUsageHeatmap(
  daily: readonly CostDailyEntry[],
  rangeStartDate: string,
  rangeEndDate: string,
) {
  // Up to two months the daily chart already shows every day; the calendar earns its space beyond.
  const rangeDays = (Date.parse(rangeEndDate) - Date.parse(rangeStartDate)) / 86_400_000 + 1;
  if (daily.length === 0 || rangeDays <= 62) {
    return undefined;
  }
  const heatmap = buildUsageHeatmap(daily, rangeStartDate, rangeEndDate);
  const legend = (
    <div class="usage-heatmap__legend" aria-hidden="true">
      <span>{t("usage.heatmap.less")}</span>
      <For each={[0, 1, 2, 3, 4]}>
        {(level) => (
          <>
            {" "}
            <span class={["usage-heatmap__swatch", `usage-heatmap__cell--l${level}`]} />{" "}
          </>
        )}
      </For>
      <span>{t("usage.heatmap.more")}</span>
    </div>
  );
  return (
    <SettingsSection
      title={t("usage.heatmap.title")}
      description={t("usage.heatmap.subtitle")}
      actions={legend}
    >
      {" "}
      <div class="usage-panel usage-heatmap">{renderHeatmapSvg(heatmap)}</div>{" "}
    </SettingsSection>
  );
}
