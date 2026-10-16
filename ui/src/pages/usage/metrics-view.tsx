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
    const maxHour = Math.max(...stats.hourTotals, 1);
    const maxWeekday = Math.max(...stats.weekdayTotals.map((d) => d.tokens), 1);

    const hours = stats.hourTotals.map((value, hour) => {
      const intensity = Math.min(value / maxHour, 1);
      const bg =
        value > 0
          ? `color-mix(in srgb, var(--accent) ${(8 + intensity * 70).toFixed(1)}%, transparent)`
          : "transparent";
      const title = `${hour}:00 · ${formatUsageTokens(value)} ${normalizeLowercaseStringOrEmpty(t("usage.metrics.tokens"))}`;
      const border =
        intensity > 0.7
          ? "color-mix(in srgb, var(--accent) 60%, transparent)"
          : "color-mix(in srgb, var(--accent) 24%, transparent)";
      return { hour, bg, title, border, selected: selectedHours.includes(hour) };
    });

    return { stats, timeZone, maxWeekday, hours, onSelectHour };
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
      <div class="usage-panel usage-mosaic">
        {state().stats.hasData ? (
          <div class="usage-mosaic-grid">
            <div class="usage-mosaic-section">
              <div class="usage-mosaic-section-title">{t("usage.mosaic.dayOfWeek")}</div>
              <div class="usage-daypart-grid">
                <For each={state().stats.weekdayTotals}>
                  {(part) => {
                    const bg = () =>
                      part.tokens > 0
                        ? `color-mix(in srgb, var(--accent) ${(12 + Math.min(part.tokens / state().maxWeekday, 1) * 60).toFixed(1)}%, transparent)`
                        : "transparent";
                    return (
                      <div class="usage-daypart-cell" style={{ background: bg() }}>
                        <div class="usage-daypart-label">{part.label}</div>
                        <div class="usage-daypart-value">{formatUsageTokens(part.tokens)}</div>
                      </div>
                    );
                  }}
                </For>
              </div>
            </div>
            <div class="usage-mosaic-section">
              <div class="usage-mosaic-section-title">
                <span>{t("usage.filters.hours")}</span>
                <span class="usage-mosaic-sub">0 → 23</span>
              </div>
              <div class="usage-hour-grid">
                <For each={state().hours} keyed={(hour) => hour.hour}>
                  {(hour) => (
                    <button
                      type="button"
                      class={["usage-hour-cell", { selected: hour().selected }]}
                      style={{ background: hour().bg, "border-color": hour().border }}
                      title={hour().title}
                      aria-label={hour().title}
                      aria-pressed={hour().selected ? "true" : "false"}
                      onClick={(event: MouseEvent) =>
                        state().onSelectHour(hour().hour, event.shiftKey)
                      }
                    />
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
              <div class="usage-hour-legend">
                <span />
                {t("usage.mosaic.legend")}
              </div>
            </div>
          </div>
        ) : (
          <div class="usage-empty-block usage-empty-block--compact">
            {t("usage.mosaic.noTimelineData")}
          </div>
        )}
      </div>
    </SettingsSection>
  );
}
