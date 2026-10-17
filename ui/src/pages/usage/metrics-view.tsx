import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { createMemo, For } from "solid-js";
import { SettingsSection } from "../../components/solid/settings-ui.tsx";
import { t } from "../../lib/reactive/i18n.ts";
import type { SessionsUsageResult } from "./data-types.ts";
import { formatUsageTokens } from "./metrics.ts";

export function UsageMosaic(props: {
  overview: SessionsUsageResult["overview"];
  timeZone: "local" | "utc";
  selectedHours: number[];
  onSelectHour: (hour: number, shiftKey: boolean) => void;
}) {
  const state = createMemo(() => {
    const timeZone = props.timeZone;
    const selectedHours = props.selectedHours;
    const onSelectHour = props.onSelectHour;
    const stats = {
      hasData: props.overview?.hasTimelineData ?? false,
      totalTokens: props.overview?.hourTokens.reduce((sum, value) => sum + value, 0) ?? 0,
      hourTotals: props.overview?.hourTokens ?? Array.from({ length: 24 }, () => 0),
      weekdayTotals: ["sun", "mon", "tue", "wed", "thu", "fri", "sat"].map((day, index) => ({
        label: t(`usage.mosaic.${day}`),
        tokens: props.overview?.weekdayTokens[index] ?? 0,
      })),
    };
    const maxHour = Math.max(...stats.hourTotals, 0);
    const maxWeekday = Math.max(...stats.weekdayTotals.map((day) => day.tokens), 0);
    const share = (value: number, max: number) => (max > 0 ? (value / max) * 100 : 0);
    const weekdays = stats.weekdayTotals.map((day) => ({
      ...day,
      share: share(day.tokens, maxWeekday),
      peak: maxWeekday > 0 && day.tokens === maxWeekday,
    }));
    const hours = stats.hourTotals.map((value, hour) => ({
      hour,
      share: share(value, maxHour),
      // A selection takes the accent; the peak only marks itself when nothing is selected.
      peak: selectedHours.length === 0 && maxHour > 0 && value === maxHour,
      title: `${hour}:00 · ${formatUsageTokens(value)} ${normalizeLowercaseStringOrEmpty(t("usage.metrics.tokens"))}`,
      selected: selectedHours.includes(hour),
    }));

    return { stats, timeZone, weekdays, hours, onSelectHour };
  });
  return (
    <SettingsSection
      title={t("usage.mosaic.title")}
      description={
        state().stats.hasData
          ? t("usage.mosaic.subtitle", {
              zone:
                state().timeZone === "utc"
                  ? t("usage.filters.timeZoneUtc")
                  : t("usage.filters.timeZoneLocal"),
            })
          : t("usage.mosaic.subtitleEmpty")
      }
      actions={
        <div class="usage-mosaic-total">
          {formatUsageTokens(state().stats.hasData ? state().stats.totalTokens : 0)}{" "}
          {normalizeLowercaseStringOrEmpty(t("usage.metrics.tokens"))}
        </div>
      }
    >
      {/* One hairline-divided surface: day-of-week meters beside an hourly column chart. */}
      <div class="usage-mosaic">
        {state().stats.hasData ? (
          <>
            <div class="usage-mosaic-section">
              <div class="usage-mosaic-section-title">{t("usage.mosaic.dayOfWeek")}</div>
              <ul class="usage-weekdays">
                <For each={state().weekdays}>
                  {(day) => (
                    <li class={["usage-weekday", { "usage-weekday--peak": day.peak }]}>
                      <span class="usage-weekday__label">{day.label}</span>
                      <span class="usage-weekday__track" aria-hidden="true">
                        <span class="usage-weekday__fill" style={{ width: `${day.share}%` }} />
                      </span>
                      <span class="usage-weekday__value">{formatUsageTokens(day.tokens)}</span>
                    </li>
                  )}
                </For>
              </ul>
            </div>
            <div class="usage-mosaic-section">
              <div class="usage-mosaic-section-title">{t("usage.filters.hours")}</div>
              <div class="usage-hour-grid">
                <For each={state().hours} keyed={(hour) => hour.hour}>
                  {(hour) => (
                    <button
                      type="button"
                      class={[
                        "usage-hour-cell",
                        { selected: hour().selected, "usage-hour-cell--peak": hour().peak },
                      ]}
                      title={hour().title}
                      aria-label={hour().title}
                      aria-pressed={hour().selected ? "true" : "false"}
                      onClick={(event: MouseEvent) =>
                        state().onSelectHour(hour().hour, event.shiftKey)
                      }
                    >
                      <span class="usage-hour-cell__bar" style={{ height: `${hour().share}%` }} />
                    </button>
                  )}
                </For>
              </div>
              <div class="usage-hour-labels">
                <span>{t("usage.mosaic.midnight")}</span>
                <span>{t("usage.mosaic.fourAm")}</span>
                <span>{t("usage.mosaic.eightAm")}</span>
                <span>{t("usage.mosaic.noon")}</span>
                <span>{t("usage.mosaic.fourPm")}</span>
                <span>{t("usage.mosaic.eightPm")}</span>
              </div>
            </div>
          </>
        ) : (
          <div class="usage-empty-block usage-empty-block--compact">
            {t("usage.mosaic.noTimelineData")}
          </div>
        )}
      </div>
    </SettingsSection>
  );
}
