import { expectDefined } from "@openclaw/normalization-core";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { html, svg, nothing } from "lit";
import type { PanelRefreshStatus } from "../../components/panel-refresh-status.ts";
import { renderSettingsSegmented } from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { createMsFormatter, formatTimeMs } from "../../lib/format.ts";
import { formatIsoDate, formatUsageCost, formatUsageTokens } from "./metrics.ts";
import { renderUsageRefreshStatus } from "./page-shell.ts";
import type { TimeSeriesPoint } from "./types.ts";
import { USAGE_TOKEN_CATEGORIES } from "./view-chart.ts";

const CHART_BAR_WIDTH_RATIO = 0.75; // Fraction of slot used for bar (rest is gap)
const CHART_MAX_BAR_WIDTH = 8; // Max bar width in SVG viewBox units
const CHART_SELECTION_OPACITY = 0.06; // Opacity of range selection overlay
const HANDLE_WIDTH = 5; // Width of drag handle in SVG units
const HANDLE_HEIGHT = 12; // Height of drag handle
const HANDLE_GRIP_OFFSET = 0.7; // Offset of grip lines inside handle

function dateBoundaryMs(date: string, timeZone: "local" | "utc", dayOffset: 0 | 1): number {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7)) - 1;
  const day = Number(date.slice(8, 10)) + dayOffset;
  // Build the target date directly; advancing a normalized skipped midnight can retain 01:00.
  return timeZone === "utc" ? Date.UTC(year, month, day) : new Date(year, month, day).getTime();
}

export function renderTimeSeriesCompact(
  timeSeries: { points: TimeSeriesPoint[] } | null,
  loading: boolean,
  status: PanelRefreshStatus,
  mode: "cumulative" | "per-turn",
  onModeChange: (mode: "cumulative" | "per-turn") => void,
  breakdownMode: "total" | "by-type",
  onBreakdownChange: (mode: "total" | "by-type") => void,
  startDate?: string,
  endDate?: string,
  selectedDays?: string[],
  timeZone: "local" | "utc" = "local",
  cursorStart?: number | null,
  cursorEnd?: number | null,
  onCursorRangeChange?: (start: number | null, end: number | null) => void,
) {
  if ((loading || status.awaitingGateway) && !status.hasLoaded) {
    return html`
      <div class="session-timeseries-compact">
        <div class="usage-empty-block">${t("usage.loading.badge")}</div>
      </div>
    `;
  }
  const refreshStatus = renderUsageRefreshStatus(status, "usage.details.usageOverTime", "timeline");
  if (status.error && !status.hasLoaded) {
    return html`
      <div class="session-timeseries-compact">
        <div class="card-title usage-section-title">${t("usage.details.usageOverTime")}</div>
        ${refreshStatus}
      </div>
    `;
  }
  if (!timeSeries || timeSeries.points.length < 2) {
    return html`
      <div class="session-timeseries-compact">
        ${refreshStatus}
        <div class="usage-empty-block">${t("usage.details.noTimeline")}</div>
      </div>
    `;
  }

  let points = timeSeries.points;
  if (startDate || endDate || (selectedDays && selectedDays.length > 0)) {
    const startTs = startDate ? dateBoundaryMs(startDate, timeZone, 0) : 0;
    const endTs = endDate ? dateBoundaryMs(endDate, timeZone, 1) : Infinity;
    const selectedDaySet = selectedDays?.length ? new Set(selectedDays) : undefined;
    points = timeSeries.points.filter((p) => {
      if (p.timestamp < startTs || p.timestamp >= endTs) {
        return false;
      }
      if (selectedDaySet) {
        return selectedDaySet.has(formatIsoDate(new Date(p.timestamp), timeZone));
      }
      return true;
    });
  }
  if (points.length < 2) {
    return html`
      <div class="session-timeseries-compact">
        ${refreshStatus}
        <div class="usage-empty-block">${t("usage.details.noDataInRange")}</div>
      </div>
    `;
  }
  let cumTokens = 0,
    cumCost = 0;
  points = points.map((p) => {
    cumTokens += p.totalTokens;
    cumCost += p.cost;
    return { ...p, cumulativeTokens: cumTokens, cumulativeCost: cumCost };
  });

  const hasSelection = cursorStart != null && cursorEnd != null;
  const rangeStartTs = hasSelection ? Math.min(cursorStart, cursorEnd) : 0;
  const rangeEndTs = hasSelection ? Math.max(cursorStart, cursorEnd) : Infinity;

  // Find start/end indices for dimming
  let rangeStartIdx = 0;
  let rangeEndIdx = points.length;
  if (hasSelection) {
    rangeStartIdx = points.findIndex((p) => p.timestamp >= rangeStartTs);
    if (rangeStartIdx === -1) {
      rangeStartIdx = points.length;
    }
    const endIdx = points.findIndex((p) => p.timestamp > rangeEndTs);
    rangeEndIdx = endIdx === -1 ? points.length : endIdx;
  }

  const filteredPoints = hasSelection ? points.slice(rangeStartIdx, rangeEndIdx) : points;
  const filteredTokens = { output: 0, input: 0, cacheRead: 0, cacheWrite: 0 };
  for (const p of filteredPoints) {
    for (const { key } of USAGE_TOKEN_CATEGORIES) {
      filteredTokens[key] += p[key];
    }
  }

  const width = 400,
    height = 100;
  const padding = { top: 8, right: 4, bottom: 14, left: 30 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;
  const isCumulative = mode === "cumulative";
  const breakdownByType = mode === "per-turn" && breakdownMode === "by-type";
  const timeZoneOptions: Intl.DateTimeFormatOptions = timeZone === "utc" ? { timeZone: "UTC" } : {};
  const formatTooltipTimestamp = createMsFormatter(
    { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", ...timeZoneOptions },
    "",
  );

  const totalTypeTokens = Object.values(filteredTokens).reduce(
    (total, tokens) => total + tokens,
    0,
  );
  const barTotals = points.map((p) =>
    isCumulative
      ? p.cumulativeTokens
      : breakdownByType
        ? p.input + p.output + p.cacheRead + p.cacheWrite
        : p.totalTokens,
  );
  const maxValue = Math.max(...barTotals, 1);
  // Ensure bars + gaps fit exactly within chartWidth
  const slotWidth = chartWidth / points.length; // space per bar including gap
  const barWidth = Math.min(CHART_MAX_BAR_WIDTH, Math.max(1, slotWidth * CHART_BAR_WIDTH_RATIO));
  const barGap = slotWidth - barWidth;

  const leftHandleX = padding.left + rangeStartIdx * (barWidth + barGap);
  const rightHandleX =
    rangeEndIdx >= points.length
      ? padding.left + (points.length - 1) * (barWidth + barGap) + barWidth // right edge of last bar
      : padding.left + (rangeEndIdx - 1) * (barWidth + barGap) + barWidth; // right edge of last selected bar
  const firstTimestamp = expectDefined(points[0], "time series first point").timestamp;
  const lastTimestamp = expectDefined(points.at(-1), "time series last point").timestamp;
  const cursorLeft = Math.max(firstTimestamp, Math.min(lastTimestamp, rangeStartTs));
  const cursorRight = Math.max(firstTimestamp, Math.min(lastTimestamp, rangeEndTs));
  const moveCursor = (side: "left" | "right", timestamp: number) => {
    onCursorRangeChange?.(
      side === "left" ? Math.max(firstTimestamp, Math.min(timestamp, cursorRight)) : cursorLeft,
      side === "right" ? Math.min(lastTimestamp, Math.max(timestamp, cursorLeft)) : cursorRight,
    );
  };
  const handleCursorKeydown = (event: KeyboardEvent, side: "left" | "right") => {
    const current = side === "left" ? cursorLeft : cursorRight;
    const minimum = side === "left" ? firstTimestamp : cursorLeft;
    const maximum = side === "left" ? cursorRight : lastTimestamp;
    let timestamp: number;
    switch (event.key) {
      case "ArrowLeft":
      case "ArrowDown":
        timestamp = points.findLast((point) => point.timestamp < current)?.timestamp ?? minimum;
        break;
      case "ArrowRight":
      case "ArrowUp":
        timestamp = points.find((point) => point.timestamp > current)?.timestamp ?? maximum;
        break;
      case "Home":
        timestamp = minimum;
        break;
      case "End":
        timestamp = maximum;
        break;
      default:
        return;
    }
    event.preventDefault();
    moveCursor(side, timestamp);
  };

  return html`
    <div class="session-timeseries-compact">
      <div class="timeseries-header-row">
        <div class="card-title usage-section-title">${t("usage.details.usageOverTime")}</div>
        <div class="timeseries-controls">
          ${
            hasSelection
              ? html`
                  <div class="settings-segmented settings-segmented--accent small">
                    <button
                      class="btn btn--sm settings-segmented__btn settings-segmented__btn--active"
                      @click=${() => onCursorRangeChange?.(null, null)}
                    >
                      ${t("usage.details.reset")}
                    </button>
                  </div>
                `
              : nothing
          }
          ${renderSettingsSegmented({
            mode: "buttons",
            variant: "accent",
            className: "small",
            value: mode,
            onChange: onModeChange,
            onReselect: onModeChange,
            options: [
              { value: "per-turn", label: t("usage.details.perTurn") },
              { value: "cumulative", label: t("usage.details.cumulative") },
            ],
          })}
          ${
            !isCumulative
              ? renderSettingsSegmented({
                  mode: "buttons",
                  variant: "accent",
                  className: "small",
                  value: breakdownMode,
                  onChange: onBreakdownChange,
                  onReselect: onBreakdownChange,
                  options: [
                    { value: "total", label: t("usage.daily.total") },
                    { value: "by-type", label: t("usage.daily.byType") },
                  ],
                })
              : nothing
          }
        </div>
      </div>
      ${refreshStatus}
      <div class="timeseries-chart-wrapper">
        <svg viewBox="0 0 ${width} ${height + 18}" class="timeseries-svg">
          ${[
            { x1: padding.left, y1: padding.top, x2: padding.left, y2: padding.top + chartHeight },
            {
              x1: padding.left,
              y1: padding.top + chartHeight,
              x2: width - padding.right,
              y2: padding.top + chartHeight,
            },
          ].map(
            ({ x1, y1, x2, y2 }) =>
              svg`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="var(--border)" />`,
          )}
          ${[
            { y: padding.top + 5, text: formatUsageTokens(maxValue) },
            { y: padding.top + chartHeight, text: "0" },
          ].map(
            ({ y, text }) =>
              svg`<text x="${padding.left - 4}" y="${y}" text-anchor="end" class="ts-axis-label">${text}</text>`,
          )}
          <!-- X axis labels (first and last) -->
          ${svg`
            <text x="${padding.left}" y="${padding.top + chartHeight + 10}" text-anchor="start" class="ts-axis-label">${formatTimeMs(expectDefined(points[0], "time series first point").timestamp, { hour: "2-digit", minute: "2-digit", ...timeZoneOptions }, "")}</text>
            <text x="${width - padding.right}" y="${padding.top + chartHeight + 10}" text-anchor="end" class="ts-axis-label">${formatTimeMs(expectDefined(points.at(-1), "time series last point").timestamp, { hour: "2-digit", minute: "2-digit", ...timeZoneOptions }, "")}</text>
          `}
          <!-- Bars -->
          ${points.map((p, i) => {
            const val = expectDefined(barTotals[i], "time series bar total");
            const x = padding.left + i * (barWidth + barGap);
            const bh = (val / maxValue) * chartHeight;
            const y = padding.top + chartHeight - bh;
            const tooltipLines = [
              formatTooltipTimestamp(p.timestamp),
              `${formatUsageTokens(val)} ${normalizeLowercaseStringOrEmpty(t("usage.metrics.tokens"))}`,
            ];
            if (breakdownByType) {
              tooltipLines.push(
                ...USAGE_TOKEN_CATEGORIES.map(
                  ({ key, short }) => `${short} ${formatUsageTokens(p[key])}`,
                ),
              );
            }
            const tooltip = tooltipLines.join(" · ");
            const isOutside = hasSelection && (i < rangeStartIdx || i >= rangeEndIdx);

            if (!breakdownByType) {
              return svg`<rect x="${x}" y="${y}" width="${barWidth}" height="${bh}" class="ts-bar${isOutside ? " dimmed" : ""}" rx="1" role="img" data-tooltip=${tooltip} aria-label=${tooltip}></rect>`;
            }
            let yC = padding.top + chartHeight;
            const dim = isOutside ? " dimmed" : "";
            return svg`
              ${USAGE_TOKEN_CATEGORIES.map(({ key, className }) => {
                const value = p[key];
                if (value <= 0 || val <= 0) {
                  return nothing;
                }
                const sh = bh * (value / val);
                yC -= sh;
                return svg`<rect x="${x}" y="${yC}" width="${barWidth}" height="${sh}" class="ts-bar ${className}${dim}" rx="1" role="img" data-tooltip=${tooltip} aria-label=${tooltip}></rect>`;
              })}
            `;
          })}
          <!-- Selection highlight overlay (always visible between handles) -->
          ${svg`
            <rect
              x="${leftHandleX}"
              y="${padding.top}"
              width="${Math.max(1, rightHandleX - leftHandleX)}"
              height="${chartHeight}"
              fill="var(--accent)"
              opacity="${CHART_SELECTION_OPACITY}"
              pointer-events="none"
            />
          `}
          ${[leftHandleX, rightHandleX].map(
            (handleX) => svg`
              <line x1="${handleX}" y1="${padding.top}" x2="${handleX}" y2="${padding.top + chartHeight}" stroke="var(--accent)" stroke-width="0.8" opacity="0.7" />
              <rect x="${handleX - HANDLE_WIDTH / 2}" y="${padding.top + chartHeight / 2 - HANDLE_HEIGHT / 2}" width="${HANDLE_WIDTH}" height="${HANDLE_HEIGHT}" rx="1.5" fill="var(--accent)" class="cursor-handle" />
              ${[-HANDLE_GRIP_OFFSET, HANDLE_GRIP_OFFSET].map(
                (offset) =>
                  svg`<line x1="${handleX + offset}" y1="${padding.top + chartHeight / 2 - HANDLE_HEIGHT / 5}" x2="${handleX + offset}" y2="${padding.top + chartHeight / 2 + HANDLE_HEIGHT / 5}" stroke="var(--bg)" stroke-width="0.4" pointer-events="none" />`,
              )}
            `,
          )}
        </svg>
        <!-- Handle drag zones (only on handles, not full chart) -->
        ${(() => {
          const makeDragHandler = (side: "left" | "right") => (e: MouseEvent) => {
            if (!onCursorRangeChange || !(e.currentTarget instanceof HTMLElement)) {
              return;
            }
            e.preventDefault();
            e.stopPropagation();
            const wrapper = e.currentTarget.closest(".timeseries-chart-wrapper");
            const svgEl = wrapper?.querySelector("svg");
            if (!svgEl) {
              return;
            }
            // Capture rect once at mousedown to avoid re-render offset shifts
            const rect = svgEl.getBoundingClientRect();
            const svgWidth = rect.width;
            const chartLeftPx = (padding.left / width) * svgWidth;
            const chartRightPx = ((width - padding.right) / width) * svgWidth;
            const chartW = chartRightPx - chartLeftPx;

            const posToIdx = (clientX: number) => {
              const x = Math.max(0, Math.min(1, (clientX - rect.left - chartLeftPx) / chartW));
              return Math.min(Math.floor(x * points.length), points.length - 1);
            };

            // Compute click offset: where on the handle the user grabbed
            const handleSvgX = side === "left" ? leftHandleX : rightHandleX;
            const handleClientX = rect.left + (handleSvgX / width) * svgWidth;
            const grabOffset = e.clientX - handleClientX;

            document.body.style.cursor = "col-resize";

            const handleMove = (me: MouseEvent) => {
              const adjustedX = me.clientX - grabOffset;
              const idx = posToIdx(adjustedX);
              const pt = points[idx];
              if (!pt) {
                return;
              }
              moveCursor(side, pt.timestamp);
            };

            const handleUp = () => {
              document.body.style.cursor = "";
              document.removeEventListener("mousemove", handleMove);
              document.removeEventListener("mouseup", handleUp);
            };

            document.addEventListener("mousemove", handleMove);
            document.addEventListener("mouseup", handleUp);
          };

          return html`
            ${(["left", "right"] as const).map((side) => {
              const x = side === "left" ? leftHandleX : rightHandleX;
              return html`<div
                class="chart-handle-zone chart-handle-${side}"
                role="slider"
                tabindex="0"
                aria-label=${t(side === "left" ? "usage.details.rangeStart" : "usage.details.rangeEnd")}
                aria-valuemin=${side === "left" ? firstTimestamp : cursorLeft}
                aria-valuemax=${side === "left" ? cursorRight : lastTimestamp}
                aria-valuenow=${side === "left" ? cursorLeft : cursorRight}
                aria-valuetext=${formatTooltipTimestamp(side === "left" ? cursorLeft : cursorRight)}
                style="left: ${((x / width) * 100).toFixed(1)}%;"
                @mousedown=${makeDragHandler(side)}
                @keydown=${(event: KeyboardEvent) => handleCursorKeydown(event, side)}
              ></div>`;
            })}
          `;
        })()}
      </div>
      <div class="timeseries-summary">
        ${
          hasSelection
            ? html`
                <span class="timeseries-summary__range">
                  ${t("usage.details.turnRange", {
                    start: String(rangeStartIdx + 1),
                    end: String(rangeEndIdx),
                    total: String(points.length),
                  })}
                </span>
                ·
                ${formatTimeMs(
                  rangeStartTs,
                  { hour: "2-digit", minute: "2-digit", ...timeZoneOptions },
                  "",
                )}–${formatTimeMs(
                  rangeEndTs,
                  { hour: "2-digit", minute: "2-digit", ...timeZoneOptions },
                  "",
                )}
                · ${formatUsageTokens(totalTypeTokens)} ·
                ${formatUsageCost(filteredPoints.reduce((s, p) => s + (p.cost || 0), 0))}
              `
            : html`${points.length} ${t("usage.overview.messagesAbbrev")} ·
              ${formatUsageTokens(cumTokens)} · ${formatUsageCost(cumCost)}`
        }
      </div>
      ${
        breakdownByType
          ? html`
              <div class="timeseries-breakdown">
                <div class="card-title usage-section-title">
                  ${t("usage.breakdown.tokensByType")}
                </div>
                <div class="cost-breakdown-bar cost-breakdown-bar--compact">
                  ${USAGE_TOKEN_CATEGORIES.map(
                    ({ key, className }) => html`
                      <div
                        class="cost-segment ${className}"
                        style="width: ${(totalTypeTokens > 0 ? (filteredTokens[key] / totalTypeTokens) * 100 : 0).toFixed(1)}%"
                      ></div>
                    `,
                  )}
                </div>
                <div class="cost-breakdown-legend">
                  ${USAGE_TOKEN_CATEGORIES.map(
                    ({ key, className, labelKey, hintKey }) => html`
                      <div class="legend-item" title=${t(hintKey)}>
                        <span class="legend-dot ${className}"></span>${t(labelKey)}
                        ${formatUsageTokens(filteredTokens[key])}
                      </div>
                    `,
                  )}
                </div>
                <div class="cost-breakdown-total">
                  ${t("usage.breakdown.total")}: ${formatUsageTokens(totalTypeTokens)}
                </div>
              </div>
            `
          : nothing
      }
    </div>
  `;
}
