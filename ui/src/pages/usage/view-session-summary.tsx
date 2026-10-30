import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { For } from "solid-js";
import { formatDurationCompact } from "../../lib/format-duration.ts";
import { formatMs } from "../../lib/format.ts";
import { t } from "../../lib/reactive/i18n.ts";
import type { ParsedSessionLog } from "./helpers.ts";
import { formatUsageCost, formatUsageTokens } from "./metrics.ts";
import type { UsageSessionEntry } from "./types.ts";
import { renderInsightList } from "./view-overview.tsx";

export function renderSessionSummary(
  session: UsageSessionEntry,
  filteredUsage?: UsageSessionEntry["usage"],
  filteredLogs?: ParsedSessionLog[] | null,
) {
  const usage = filteredUsage || session.usage;
  if (!usage) {
    return <div class="usage-empty-block">{t("usage.details.noUsageData")}</div>;
  }

  // One compact span: the date once, then both times when the session stayed within a day.
  const formatActivitySpan = (first?: number, last?: number): string => {
    if (!first || !last) {
      return first || last ? formatMs((first || last)!) : t("usage.common.emptyValue");
    }
    const day = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
    const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
    const sameDay = day.format(first) === day.format(last);
    return sameDay
      ? `${day.format(first)}, ${time.format(first)} – ${time.format(last)}`
      : `${day.format(first)}, ${time.format(first)} → ${day.format(last)}, ${time.format(last)}`;
  };
  const hasInterval = filteredLogs !== undefined;
  const datedLogs = filteredLogs?.filter(({ log }) => log.timestamp > 0);
  const messageCounts = !hasInterval
    ? usage.messageCounts
    : datedLogs?.length
      ? datedLogs.reduce(
          (counts, { log: { role } }) => {
            if (role === "user" || role === "assistant") {
              counts[role] += 1;
              counts.total += 1;
            }
            return counts;
          },
          { total: 0, user: 0, assistant: 0 },
        )
      : undefined;

  const badges = [
    session.channel && `channel:${session.channel}`,
    session.agentId && `agent:${session.agentId}`,
    (session.modelProvider || session.providerOverride) &&
      `provider:${session.modelProvider ?? session.providerOverride}`,
    session.model && `model:${session.model}`,
  ].filter(Boolean);

  // Always use the full tool list for stable layout; update counts when filtering
  const baseTools = usage.toolUsage?.tools.slice(0, 6) ?? [];
  let toolCounts: Map<string, number> | undefined;
  if (datedLogs?.length) {
    toolCounts = new Map();
    // Result rows carry tool names for filtering, but only assistant rows record calls.
    for (const { toolInfo } of datedLogs.filter(({ log }) => log.role === "assistant")) {
      for (const [name, count] of toolInfo.tools) {
        toolCounts.set(name, (toolCounts.get(name) ?? 0) + count);
      }
    }
  }
  const toolItems = baseTools.map((tool) => {
    const count = toolCounts ? (toolCounts.get(tool.name) ?? 0) : tool.count;
    return {
      label: tool.name,
      value: `${!toolCounts && hasInterval ? t("usage.common.emptyValue") : count}`,
      weight: !toolCounts && hasInterval ? 0 : count,
    };
  });
  const toolCallCount = toolCounts
    ? [...toolCounts.values()].reduce((sum, count) => sum + count, 0)
    : hasInterval
      ? t("usage.common.emptyValue")
      : (usage.toolUsage?.totalCalls ?? 0);
  const uniqueToolCount = toolCounts
    ? toolCounts.size
    : hasInterval
      ? t("usage.common.emptyValue")
      : (usage.toolUsage?.uniqueTools ?? 0);
  const modelItems =
    usage.modelUsage?.slice(0, 6).map((entry) => ({
      label: entry.model ?? t("usage.common.unknown"),
      value: formatUsageCost(entry.totals.totalCost),
      weight: entry.totals.totalCost || entry.totals.totalTokens / 1e9,
      sub: formatUsageTokens(entry.totals.totalTokens),
    })) ?? [];
  const cards = [
    {
      labelKey: "usage.overview.messages",
      value: messageCounts?.total ?? (hasInterval ? t("usage.common.emptyValue") : 0),
      meta: (
        <>
          {" "}
          {hasInterval && !messageCounts
            ? t("usage.common.emptyValue")
            : `${(messageCounts?.user ?? 0).toLocaleString()} ${normalizeLowercaseStringOrEmpty(t("usage.overview.user"))} · ${(messageCounts?.assistant ?? 0).toLocaleString()} ${normalizeLowercaseStringOrEmpty(t("usage.overview.assistant"))}`}
          {hasInterval ? (
            <>
              {" "}
              <br />
              {t("usage.details.loadedIntervalMessages")}{" "}
            </>
          ) : undefined}{" "}
        </>
      ),
    },
    {
      labelKey: "usage.overview.toolCalls",
      value: toolCallCount,
      meta: (
        <>
          {" "}
          {uniqueToolCount} {t("usage.overview.toolsUsed")}{" "}
        </>
      ),
    },
    {
      labelKey: "usage.overview.errors",
      value: hasInterval ? t("usage.common.emptyValue") : (usage.messageCounts?.errors ?? 0),
      meta: (
        <>
          {" "}
          {hasInterval
            ? t("usage.common.emptyValue")
            : (usage.messageCounts?.toolResults ?? 0)}{" "}
          {t("usage.overview.toolResults")}{" "}
        </>
      ),
    },
    {
      labelKey: "usage.details.duration",
      value: formatDurationCompact(usage.durationMs) ?? t("usage.common.emptyValue"),
      meta: <> {formatActivitySpan(usage.firstActivity, usage.lastActivity)} </>,
    },
  ];

  return (
    <>
      {badges.length > 0 ? (
        <div class="usage-badges">
          <For each={badges}>
            {(b) => (
              <>
                {" "}
                <span class="settings-row__value">{b}</span>{" "}
              </>
            )}
          </For>
        </div>
      ) : undefined}
      <div class="session-summary-grid">
        <For each={cards}>
          {({ labelKey, value, meta }) => (
            <div class="stat session-summary-card">
              <div class="session-summary-title">{t(labelKey)}</div>
              <div class="stat-value session-summary-value">
                {typeof value === "number" ? value.toLocaleString() : value}
              </div>
              <div class="session-summary-meta">{meta}</div>
            </div>
          )}
        </For>
      </div>
      <div class="usage-insights-grid usage-insights-grid--tight">
        {renderInsightList(
          t("usage.overview.topTools"),
          toolItems,
          t("usage.overview.noToolCalls"),
        )}
        {renderInsightList(
          t("usage.details.modelMix"),
          modelItems,
          t("usage.overview.noModelData"),
        )}
      </div>
    </>
  );
}
