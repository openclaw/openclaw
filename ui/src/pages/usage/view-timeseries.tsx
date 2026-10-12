import { expectDefined } from "@openclaw/normalization-core";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { For, Show, createMemo, onCleanup } from "solid-js";
import { SettingsSegmented } from "../../components/solid/settings-ui.tsx";
import { createMsFormatter, formatTimeMs } from "../../lib/format.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { formatIsoDate } from "./helpers.ts";
import { formatUsageCost, formatUsageTokens } from "./metrics.ts";
import { renderUsageRefreshStatus } from "./page-shell.tsx";
import type { UsageProps } from "./types.ts";
import { USAGE_TOKEN_CATEGORIES } from "./view-chart.tsx";

const CHART_BAR_WIDTH_RATIO = 0.75; // Fraction of slot used for bar (rest is gap)
const CHART_MAX_BAR_WIDTH = 8; // Max bar width in SVG viewBox units
const CHART_SELECTION_OPACITY = 0.06;
const HANDLE_WIDTH = 5; // Width of drag handle in SVG units
const HANDLE_HEIGHT = 12;
const HANDLE_GRIP_OFFSET = 0.7; // Offset of grip lines inside handle

function dateBoundaryMs(date: string, timeZone: "local" | "utc", dayOffset: 0 | 1): number {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7)) - 1;
  const day = Number(date.slice(8, 10)) + dayOffset;
  // Build the target date directly; advancing a normalized skipped midnight can retain 01:00.
  return timeZone === "utc" ? Date.UTC(year, month, day) : new Date(year, month, day).getTime();
}

type TimeSeriesProps = {
  detail: UsageProps["detail"];
  callbacks: UsageProps["callbacks"]["details"];
  range: Pick<UsageProps["filters"], "startDate" | "endDate" | "selectedDays" | "timeZone">;
};

function deriveTimeSeries(detail: TimeSeriesProps["detail"], range: TimeSeriesProps["range"]) {
  const {
    timeSeries,
    timeSeriesLoading: loading,
    timeSeriesStatus: status,
    timeSeriesMode: mode,
    timeSeriesBreakdownMode: breakdownMode,
    timeSeriesCursorStart: cursorStart,
    timeSeriesCursorEnd: cursorEnd,
  } = detail;
  const { startDate, endDate, selectedDays, timeZone } = range;
  if ((loading || status.awaitingGateway) && !status.hasLoaded) {
    return { chart: null, emptyKey: "usage.loading.badge", showTitle: false, showStatus: false };
  }
  if (status.error && !status.hasLoaded) {
    return { chart: null, emptyKey: null, showTitle: true, showStatus: true };
  }
  if (!timeSeries || timeSeries.points.length < 2) {
    return {
      chart: null,
      emptyKey: "usage.details.noTimeline",
      showTitle: false,
      showStatus: true,
    };
  }
  let rangePoints = timeSeries.points;
  if (startDate || endDate || selectedDays.length > 0) {
    const startTs = startDate ? dateBoundaryMs(startDate, timeZone, 0) : 0;
    const endTs = endDate ? dateBoundaryMs(endDate, timeZone, 1) : Infinity;
    const selectedDaySet = selectedDays.length ? new Set(selectedDays) : undefined;
    rangePoints = timeSeries.points.filter((p) => {
      if (p.timestamp < startTs || p.timestamp >= endTs) {
        return false;
      }
      if (selectedDaySet) {
        return selectedDaySet.has(formatIsoDate(new Date(p.timestamp), timeZone));
      }
      return true;
    });
  }
  if (rangePoints.length < 2) {
    return {
      chart: null,
      emptyKey: "usage.details.noDataInRange",
      showTitle: false,
      showStatus: true,
    };
  }
  let cumTokens = 0,
    cumCost = 0;
  const isCumulative = mode === "cumulative";
  const breakdownByType = mode === "per-turn" && breakdownMode === "by-type";
  const points = rangePoints.map((p) => {
    cumTokens += p.totalTokens;
    cumCost += p.cost;
    return {
      timestamp: p.timestamp,
      input: p.input,
      output: p.output,
      cacheRead: p.cacheRead,
      cacheWrite: p.cacheWrite,
      cost: p.cost,
      value: isCumulative
        ? cumTokens
        : breakdownByType
          ? p.input + p.output + p.cacheRead + p.cacheWrite
          : p.totalTokens,
    };
  });

  const hasSelection = cursorStart != null && cursorEnd != null;
  const rangeStartTs = hasSelection ? Math.min(cursorStart, cursorEnd) : 0;
  const rangeEndTs = hasSelection ? Math.max(cursorStart, cursorEnd) : Infinity;

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
  const timeZoneOptions: Intl.DateTimeFormatOptions = timeZone === "utc" ? { timeZone: "UTC" } : {};
  const formatTooltipTimestamp = createMsFormatter(
    { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", ...timeZoneOptions },
    "",
  );

  const formatAxisTimestamp = (timestamp: number) =>
    formatTimeMs(timestamp, { hour: "2-digit", minute: "2-digit", ...timeZoneOptions }, "");
  const totalTypeTokens = Object.values(filteredTokens).reduce(
    (total, tokens) => total + tokens,
    0,
  );
  const maxValue = Math.max(...points.map((p) => p.value), 1);
  const slotWidth = chartWidth / points.length; // space per bar including gap
  const barWidth = Math.min(CHART_MAX_BAR_WIDTH, Math.max(1, slotWidth * CHART_BAR_WIDTH_RATIO));
  const barGap = slotWidth - barWidth;

  const leftHandleX = padding.left + rangeStartIdx * (barWidth + barGap);
  const rightHandleX =
    padding.left + (Math.min(rangeEndIdx, points.length) - 1) * (barWidth + barGap) + barWidth;
  const firstTimestamp = expectDefined(points[0], "time series first point").timestamp;
  const lastTimestamp = expectDefined(points.at(-1), "time series last point").timestamp;
  const cursorLeft = Math.max(firstTimestamp, Math.min(lastTimestamp, rangeStartTs));
  const cursorRight = Math.max(firstTimestamp, Math.min(lastTimestamp, rangeEndTs));

  const bars = points.map((point, index) => {
    const x = padding.left + index * (barWidth + barGap);
    const barHeight = (point.value / maxValue) * chartHeight;
    const y = padding.top + chartHeight - barHeight;
    const tooltipLines = [
      formatTooltipTimestamp(point.timestamp),
      `${formatUsageTokens(point.value)} ${normalizeLowercaseStringOrEmpty(t("usage.metrics.tokens"))}`,
    ];
    if (breakdownByType) {
      tooltipLines.push(
        ...USAGE_TOKEN_CATEGORIES.map(
          ({ key, short }) => `${short} ${formatUsageTokens(point[key])}`,
        ),
      );
    }
    let segmentY = padding.top + chartHeight;
    const segments = breakdownByType
      ? USAGE_TOKEN_CATEGORIES.flatMap(({ key, className }) => {
          if (point[key] <= 0 || point.value <= 0) {
            return [];
          }
          const segmentHeight = barHeight * (point[key] / point.value);
          segmentY -= segmentHeight;
          return [{ className, y: segmentY, height: segmentHeight }];
        })
      : [];
    return {
      x,
      y,
      width: barWidth,
      height: barHeight,
      tooltip: tooltipLines.join(" · "),
      stacked: breakdownByType,
      dimmed: hasSelection && (index < rangeStartIdx || index >= rangeEndIdx),
      segments,
    };
  });
  return {
    chart: {
      bars,
      firstTimestamp,
      cursorRight,
      cursorLeft,
      lastTimestamp,
      points,
      padding,
      width,
      leftHandleX,
      rightHandleX,
      hasSelection,
      mode,
      isCumulative,
      breakdownMode,
      height,
      chartHeight,
      maxValue,
      formatAxisTimestamp,
      barWidth,
      barGap,
      formatTooltipTimestamp,
      breakdownByType,
      rangeStartIdx,
      rangeEndIdx,
      rangeStartTs,
      rangeEndTs,
      totalTypeTokens,
      filteredPoints,
      cumTokens,
      cumCost,
      filteredTokens,
    },
    emptyKey: null,
    showTitle: false,
    showStatus: true,
  };
}

export function TimeSeriesCompact(props: TimeSeriesProps) {
  const view = createMemo(() => deriveTimeSeries(props.detail, props.range));
  return (
    <Show
      when={view().chart}
      fallback={
        <div class="session-timeseries-compact">
          {view().showTitle ? (
            <div class="card-title usage-section-title">{t("usage.details.usageOverTime")}</div>
          ) : undefined}
          {view().showStatus
            ? renderUsageRefreshStatus(
                props.detail.timeSeriesStatus,
                "usage.details.usageOverTime",
                "timeline",
              )
            : undefined}
          {view().emptyKey ? (
            <div class="usage-empty-block">{t(view().emptyKey ?? "")}</div>
          ) : undefined}
        </div>
      }
    >
      {(chart) => (
        <TimeSeriesChart
          model={chart()}
          callbacks={props.callbacks}
          status={props.detail.timeSeriesStatus}
        />
      )}
    </Show>
  );
}

function TimeSeriesChart(props: {
  model: NonNullable<ReturnType<typeof deriveTimeSeries>["chart"]>;
  callbacks: TimeSeriesProps["callbacks"];
  status: TimeSeriesProps["detail"]["timeSeriesStatus"];
}) {
  const model = () => props.model;
  let stopDrag: (() => void) | undefined;
  onCleanup(() => stopDrag?.());
  const moveCursor = (
    side: "left" | "right",
    timestamp: number,
    onRangeChange: TimeSeriesProps["callbacks"]["onTimeSeriesCursorRangeChange"],
  ) => {
    onRangeChange(
      side === "left"
        ? Math.max(model().firstTimestamp, Math.min(timestamp, model().cursorRight))
        : model().cursorLeft,
      side === "right"
        ? Math.min(model().lastTimestamp, Math.max(timestamp, model().cursorLeft))
        : model().cursorRight,
    );
  };
  const handleCursorKeydown = (event: KeyboardEvent, side: "left" | "right") => {
    const current = side === "left" ? model().cursorLeft : model().cursorRight;
    const minimum = side === "left" ? model().firstTimestamp : model().cursorLeft;
    const maximum = side === "left" ? model().cursorRight : model().lastTimestamp;
    let timestamp: number;
    switch (event.key) {
      case "ArrowLeft":
      case "ArrowDown":
        timestamp =
          model().points.findLast((point) => point.timestamp < current)?.timestamp ?? minimum;
        break;
      case "ArrowRight":
      case "ArrowUp":
        timestamp = model().points.find((point) => point.timestamp > current)?.timestamp ?? maximum;
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
    moveCursor(side, timestamp, props.callbacks.onTimeSeriesCursorRangeChange);
  };
  const makeDragHandler = (side: "left" | "right") => (e: MouseEvent) => {
    if (!(e.currentTarget instanceof HTMLElement)) {
      return;
    }
    stopDrag?.();
    e.preventDefault();
    e.stopPropagation();
    const wrapper = e.currentTarget.closest(".timeseries-chart-wrapper");
    const svgEl = wrapper?.querySelector("svg");
    if (!svgEl) {
      return;
    }
    // Retain the callback that guards the series identity at the start of this drag.
    const initialOnRangeChange = props.callbacks.onTimeSeriesCursorRangeChange;
    // Capture rect once at mousedown to avoid re-render offset shifts
    const rect = svgEl.getBoundingClientRect();
    const svgWidth = rect.width;
    const initialChartLeftPx = (model().padding.left / model().width) * svgWidth;
    const initialChartRightPx =
      ((model().width - model().padding.right) / model().width) * svgWidth;
    const initialChartW = initialChartRightPx - initialChartLeftPx;

    const posToIdx = (clientX: number) => {
      const x = Math.max(
        0,
        Math.min(1, (clientX - rect.left - initialChartLeftPx) / initialChartW),
      );
      return Math.min(Math.floor(x * model().points.length), model().points.length - 1);
    };

    const handleSvgX = side === "left" ? model().leftHandleX : model().rightHandleX;
    const handleClientX = rect.left + (handleSvgX / model().width) * svgWidth;
    const grabOffset = e.clientX - handleClientX;

    const previousCursor = document.body.style.cursor;
    document.body.style.cursor = "col-resize";

    const handleMove = (me: MouseEvent) => {
      const adjustedX = me.clientX - grabOffset;
      const idx = posToIdx(adjustedX);
      const pt = model().points[idx];
      if (!pt) {
        return;
      }
      moveCursor(side, pt.timestamp, initialOnRangeChange);
    };

    const handleUp = () => {
      stopDrag = undefined;
      document.body.style.cursor = previousCursor;
      document.removeEventListener("mousemove", handleMove);
      document.removeEventListener("mouseup", handleUp);
    };

    stopDrag = handleUp;
    document.addEventListener("mousemove", handleMove);
    document.addEventListener("mouseup", handleUp);
  };
  return (
    <div class="session-timeseries-compact">
      <div class="timeseries-header-row">
        <div class="card-title usage-section-title">{t("usage.details.usageOverTime")}</div>
        <div class="timeseries-controls">
          {model().hasSelection ? (
            <div class="settings-segmented settings-segmented--accent small">
              <button
                class="btn btn--sm settings-segmented__btn settings-segmented__btn--active"
                onClick={() => props.callbacks.onTimeSeriesCursorRangeChange(null, null)}
              >
                {t("usage.details.reset")}
              </button>
            </div>
          ) : undefined}
          <SettingsSegmented
            mode="buttons"
            variant="accent"
            class="small"
            value={model().mode}
            onChange={props.callbacks.onTimeSeriesModeChange}
            onReselect={props.callbacks.onTimeSeriesModeChange}
            options={[
              { value: "per-turn", label: t("usage.details.perTurn") },
              { value: "cumulative", label: t("usage.details.cumulative") },
            ]}
          />
          {!model().isCumulative ? (
            <SettingsSegmented
              mode="buttons"
              variant="accent"
              class="small"
              value={model().breakdownMode}
              onChange={props.callbacks.onTimeSeriesBreakdownChange}
              onReselect={props.callbacks.onTimeSeriesBreakdownChange}
              options={[
                { value: "total", label: t("usage.daily.total") },
                { value: "by-type", label: t("usage.daily.byType") },
              ]}
            />
          ) : undefined}
        </div>
      </div>
      {renderUsageRefreshStatus(props.status, "usage.details.usageOverTime", "timeline")}
      <div class="timeseries-chart-wrapper">
        <svg viewBox={`0 0 ${model().width} ${model().height + 18}`} class="timeseries-svg">
          <For
            each={[
              {
                x1: model().padding.left,
                y1: model().padding.top,
                x2: model().padding.left,
                y2: model().padding.top + model().chartHeight,
              },
              {
                x1: model().padding.left,
                y1: model().padding.top + model().chartHeight,
                x2: model().width - model().padding.right,
                y2: model().padding.top + model().chartHeight,
              },
            ]}
          >
            {({ x1, y1, x2, y2 }) => (
              <>
                {" "}
                <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="var(--border)" />{" "}
              </>
            )}
          </For>
          <For
            each={[
              { y: model().padding.top + 5, text: formatUsageTokens(model().maxValue) },
              { y: model().padding.top + model().chartHeight, text: "0" },
            ]}
          >
            {({ y, text }) => (
              <>
                {" "}
                <text x={model().padding.left - 4} y={y} text-anchor="end" class="ts-axis-label">
                  {text}
                </text>{" "}
              </>
            )}
          </For>
          <text
            x={model().padding.left}
            y={model().padding.top + model().chartHeight + 10}
            text-anchor="start"
            class="ts-axis-label"
          >
            {model().formatAxisTimestamp(model().firstTimestamp)}
          </text>
          <text
            x={model().width - model().padding.right}
            y={model().padding.top + model().chartHeight + 10}
            text-anchor="end"
            class="ts-axis-label"
          >
            {model().formatAxisTimestamp(model().lastTimestamp)}
          </text>
          <For each={model().bars}>
            {(bar) =>
              bar.stacked ? (
                <For each={bar.segments}>
                  {(segment) => (
                    <rect
                      x={bar.x}
                      y={segment.y}
                      width={bar.width}
                      height={segment.height}
                      class={["ts-bar", segment.className, { dimmed: bar.dimmed }]}
                      rx="1"
                      role="img"
                      data-tooltip={bar.tooltip}
                      aria-label={bar.tooltip}
                    />
                  )}
                </For>
              ) : (
                <rect
                  x={bar.x}
                  y={bar.y}
                  width={bar.width}
                  height={bar.height}
                  class={["ts-bar", { dimmed: bar.dimmed }]}
                  rx="1"
                  role="img"
                  data-tooltip={bar.tooltip}
                  aria-label={bar.tooltip}
                />
              )
            }
          </For>
          {/*  Selection highlight overlay (always visible between handles)  */}
          <rect
            x={model().leftHandleX}
            y={model().padding.top}
            width={Math.max(1, model().rightHandleX - model().leftHandleX)}
            height={model().chartHeight}
            fill="var(--accent)"
            opacity={CHART_SELECTION_OPACITY}
            pointer-events="none"
          />
          <For each={[model().leftHandleX, model().rightHandleX]}>
            {(handleX) => (
              <>
                <line
                  x1={handleX}
                  y1={model().padding.top}
                  x2={handleX}
                  y2={model().padding.top + model().chartHeight}
                  stroke="var(--accent)"
                  stroke-width="0.8"
                  opacity="0.7"
                />
                <rect
                  x={handleX - HANDLE_WIDTH / 2}
                  y={model().padding.top + model().chartHeight / 2 - HANDLE_HEIGHT / 2}
                  width={HANDLE_WIDTH}
                  height={HANDLE_HEIGHT}
                  rx="1.5"
                  fill="var(--accent)"
                  class="cursor-handle"
                />
                <For each={[-HANDLE_GRIP_OFFSET, HANDLE_GRIP_OFFSET]}>
                  {(offset) => (
                    <>
                      {" "}
                      <line
                        x1={handleX + offset}
                        y1={model().padding.top + model().chartHeight / 2 - HANDLE_HEIGHT / 5}
                        x2={handleX + offset}
                        y2={model().padding.top + model().chartHeight / 2 + HANDLE_HEIGHT / 5}
                        stroke="var(--bg)"
                        stroke-width="0.4"
                        pointer-events="none"
                      />{" "}
                    </>
                  )}
                </For>
              </>
            )}
          </For>
        </svg>
        {/*  Handle drag zones (only on handles, not full chart)  */}
        <For each={["left", "right"] as const}>
          {(side) => {
            const x = () => (side === "left" ? model().leftHandleX : model().rightHandleX);
            return (
              <div
                class={`chart-handle-zone chart-handle-${side}`}
                role="slider"
                tabindex="0"
                aria-label={t(
                  side === "left" ? "usage.details.rangeStart" : "usage.details.rangeEnd",
                )}
                aria-valuemin={side === "left" ? model().firstTimestamp : model().cursorLeft}
                aria-valuemax={side === "left" ? model().cursorRight : model().lastTimestamp}
                aria-valuenow={side === "left" ? model().cursorLeft : model().cursorRight}
                aria-valuetext={model().formatTooltipTimestamp(
                  side === "left" ? model().cursorLeft : model().cursorRight,
                )}
                style={{ left: `${((x() / model().width) * 100).toFixed(1)}%` }}
                onMouseDown={makeDragHandler(side)}
                onKeyDown={(event: KeyboardEvent) => handleCursorKeydown(event, side)}
              />
            );
          }}
        </For>
      </div>
      <div class="timeseries-summary">
        {model().hasSelection ? (
          <>
            <span class="timeseries-summary__range">
              {t("usage.details.turnRange", {
                start: String(model().rangeStartIdx + 1),
                end: String(model().rangeEndIdx),
                total: String(model().points.length),
              })}
            </span>
            {" · "}
            {model().formatAxisTimestamp(model().rangeStartTs)}–
            {model().formatAxisTimestamp(model().rangeEndTs)}
            {" · "}
            {formatUsageTokens(model().totalTypeTokens)}
            {" · "}
            {formatUsageCost(model().filteredPoints.reduce((s, p) => s + (p.cost || 0), 0))}
          </>
        ) : (
          <>
            {" "}
            {model().points.length} {t("usage.overview.messagesAbbrev")}
            {" · "}
            {formatUsageTokens(model().cumTokens)}
            {" · "}
            {formatUsageCost(model().cumCost)}{" "}
          </>
        )}
      </div>
      {model().breakdownByType ? (
        <div class="timeseries-breakdown">
          <div class="card-title usage-section-title">{t("usage.breakdown.tokensByType")}</div>
          <div class="cost-breakdown-bar cost-breakdown-bar--compact">
            <For each={USAGE_TOKEN_CATEGORIES}>
              {({ key, className }) => (
                <div
                  class={`cost-segment ${className}`}
                  style={{
                    width: `${(model().totalTypeTokens > 0 ? (model().filteredTokens[key] / model().totalTypeTokens) * 100 : 0).toFixed(1)}%`,
                  }}
                />
              )}
            </For>
          </div>
          <div class="cost-breakdown-legend">
            <For each={USAGE_TOKEN_CATEGORIES}>
              {({ key, className, labelKey, hintKey }) => (
                <div class="legend-item" title={t(hintKey)}>
                  <span class={`legend-dot ${className}`} />
                  {t(labelKey)} {formatUsageTokens(model().filteredTokens[key])}
                </div>
              )}
            </For>
          </div>
          <div class="cost-breakdown-total">
            {t("usage.breakdown.total")}: {formatUsageTokens(model().totalTypeTokens)}
          </div>
        </div>
      ) : undefined}
    </div>
  );
}
