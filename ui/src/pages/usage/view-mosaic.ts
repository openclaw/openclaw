import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { html } from "lit";
import { renderSettingsSection } from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { buildUsageMosaicStats, formatUsageTokens } from "./metrics.ts";
import type { UsageSessionEntry } from "./types.ts";

export function renderUsageMosaic(
  sessions: UsageSessionEntry[],
  timeZone: "local" | "utc",
  selectedHours: number[],
  onSelectHour: (hour: number, shiftKey: boolean) => void,
) {
  const stats = buildUsageMosaicStats(sessions, timeZone);
  const maxHour = Math.max(...stats.hourTotals, 1);
  const maxWeekday = Math.max(...stats.weekdayTotals.map((d) => d.tokens), 1);

  return renderSettingsSection(
    {
      title: t("usage.mosaic.title"),
      description: stats.hasData
        ? t("usage.mosaic.subtitle", {
            zone:
              timeZone === "utc"
                ? t("usage.filters.timeZoneUtc")
                : t("usage.filters.timeZoneLocal"),
          })
        : t("usage.mosaic.subtitleEmpty"),
      actions: html`
        <div class="usage-mosaic-total">
          ${formatUsageTokens(stats.hasData ? stats.totalTokens : 0)}
          ${normalizeLowercaseStringOrEmpty(t("usage.metrics.tokens"))}
        </div>
      `,
    },
    html`
      <div class="usage-panel usage-mosaic">
        ${
          stats.hasData
            ? html`
                <div class="usage-mosaic-grid">
                  <div class="usage-mosaic-section">
                    <div class="usage-mosaic-section-title">${t("usage.mosaic.dayOfWeek")}</div>
                    <div class="usage-daypart-grid">
                      ${stats.weekdayTotals.map((part) => {
                        const intensity = Math.min(part.tokens / maxWeekday, 1);
                        const bg =
                          part.tokens > 0
                            ? `color-mix(in srgb, var(--accent) ${(12 + intensity * 60).toFixed(1)}%, transparent)`
                            : "transparent";
                        return html`
                          <div class="usage-daypart-cell" style="background: ${bg};">
                            <div class="usage-daypart-label">${part.label}</div>
                            <div class="usage-daypart-value">${formatUsageTokens(part.tokens)}</div>
                          </div>
                        `;
                      })}
                    </div>
                  </div>
                  <div class="usage-mosaic-section">
                    <div class="usage-mosaic-section-title">
                      <span>${t("usage.filters.hours")}</span>
                      <span class="usage-mosaic-sub">0 → 23</span>
                    </div>
                    <div class="usage-hour-grid">
                      ${stats.hourTotals.map((value, hour) => {
                        const intensity = Math.min(value / maxHour, 1);
                        const bg =
                          value > 0
                            ? `color-mix(in srgb, var(--accent) ${(8 + intensity * 70).toFixed(1)}%, transparent)`
                            : "transparent";
                        const title = `${hour}:00 · ${formatUsageTokens(value)} ${normalizeLowercaseStringOrEmpty(
                          t("usage.metrics.tokens"),
                        )}`;
                        const border =
                          intensity > 0.7
                            ? "color-mix(in srgb, var(--accent) 60%, transparent)"
                            : "color-mix(in srgb, var(--accent) 24%, transparent)";
                        const selected = selectedHours.includes(hour);
                        return html`
                          <button
                            type="button"
                            class="usage-hour-cell ${selected ? "selected" : ""}"
                            style="background: ${bg}; border-color: ${border};"
                            title="${title}"
                            aria-label=${title}
                            aria-pressed=${selected ? "true" : "false"}
                            @click=${(e: MouseEvent) => onSelectHour(hour, e.shiftKey)}
                          ></button>
                        `;
                      })}
                    </div>
                    <div class="usage-hour-labels">
                      <span>${t("usage.mosaic.midnight")}</span>
                      <span>${t("usage.mosaic.fourAm")}</span>
                      <span>${t("usage.mosaic.eightAm")}</span>
                      <span>${t("usage.mosaic.noon")}</span>
                      <span>${t("usage.mosaic.fourPm")}</span>
                      <span>${t("usage.mosaic.eightPm")}</span>
                    </div>
                    <div class="usage-hour-legend">
                      <span></span>
                      ${t("usage.mosaic.legend")}
                    </div>
                  </div>
                </div>
              `
            : html`<div class="usage-empty-block usage-empty-block--compact">
                ${t("usage.mosaic.noTimelineData")}
              </div>`
        }
      </div>
    `,
  );
}
