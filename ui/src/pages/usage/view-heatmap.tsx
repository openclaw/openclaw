import { For } from "solid-js";
import { SettingsSection } from "../../components/solid/settings-ui.tsx";
import { t } from "../../lib/reactive/i18n.ts";
import { buildUsageHeatmap, type UsageHeatmap } from "./heatmap.ts";
import { formatFullDate } from "./metrics.ts";
import type { CostDailyEntry } from "./types.ts";

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

function renderHeatmapSvg(heatmap: UsageHeatmap) {
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
            <>
              {" "}
              <text class="usage-heatmap__month" x={HEATMAP_LEFT + index() * HEATMAP_PITCH} y="10">
                {label}
              </text>{" "}
            </>
          ) : undefined
        }
      </For>
      <For each={WEEKDAY_LABEL_ROWS}>
        {({ row, utcDay }) => (
          <>
            {" "}
            <text
              class="usage-heatmap__weekday"
              x={HEATMAP_LEFT - 6}
              y={HEATMAP_TOP + row * HEATMAP_PITCH + HEATMAP_CELL - 2}
            >
              {weekdayFormat.format(new Date(utcDay))}
            </text>{" "}
          </>
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
                  tokens: numberFormat.format(day.tokens),
                })}`;
              return (
                <rect
                  class={`usage-heatmap__cell usage-heatmap__cell--l${day.level}`}
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
  if (daily.length === 0) {
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
            <span class={`usage-heatmap__swatch usage-heatmap__cell--l${level}`} />{" "}
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
