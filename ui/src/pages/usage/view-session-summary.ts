import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import { formatDurationCompact } from "../../lib/format-duration.ts";
import { formatMs } from "../../lib/format.ts";
import { parseToolSummary } from "./helpers.ts";
import { formatUsageCost, formatUsageTokens } from "./metrics.ts";
import type { SessionLogEntry, UsageSessionEntry } from "./types.ts";
import { renderInsightList } from "./view-overview.ts";

export function renderSessionSummary(
  session: UsageSessionEntry,
  filteredUsage?: UsageSessionEntry["usage"],
  filteredLogs?: SessionLogEntry[] | null,
) {
  const usage = filteredUsage || session.usage;
  if (!usage) {
    return html` <div class="usage-empty-block">${t("usage.details.noUsageData")}</div> `;
  }

  const formatTs = (ts?: number): string => (ts ? formatMs(ts) : t("usage.common.emptyValue"));
  const hasInterval = filteredLogs !== undefined;
  const datedLogs = filteredLogs?.filter((log) => log.timestamp > 0);
  const messageCounts = !hasInterval
    ? usage.messageCounts
    : datedLogs?.length
      ? datedLogs.reduce(
          (counts, { role }) => {
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
    for (const log of datedLogs.filter(({ role }) => role === "assistant")) {
      for (const [name, count] of parseToolSummary(log.content).tools) {
        toolCounts.set(name, (toolCounts.get(name) ?? 0) + count);
      }
    }
  }
  const toolItems = baseTools.map((tool) => ({
    label: tool.name,
    value: `${toolCounts ? (toolCounts.get(tool.name) ?? 0) : hasInterval ? t("usage.common.emptyValue") : tool.count}`,
    sub: t("usage.overview.calls"),
  }));
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
      sub: formatUsageTokens(entry.totals.totalTokens),
    })) ?? [];
  const cards = [
    {
      labelKey: "usage.overview.messages",
      value: messageCounts?.total ?? (hasInterval ? t("usage.common.emptyValue") : 0),
      meta: html`${
        hasInterval && !messageCounts
          ? t("usage.common.emptyValue")
          : html`${messageCounts?.user ?? 0}
            ${normalizeLowercaseStringOrEmpty(t("usage.overview.user"))} ·
            ${messageCounts?.assistant ?? 0}
            ${normalizeLowercaseStringOrEmpty(t("usage.overview.assistant"))}`
      }${hasInterval ? html`<br />${t("usage.details.loadedIntervalMessages")}` : nothing}`,
    },
    {
      labelKey: "usage.overview.toolCalls",
      value: toolCallCount,
      meta: html`${uniqueToolCount} ${t("usage.overview.toolsUsed")}`,
    },
    {
      labelKey: "usage.overview.errors",
      value: hasInterval ? t("usage.common.emptyValue") : (usage.messageCounts?.errors ?? 0),
      meta: html`${hasInterval ? t("usage.common.emptyValue") : (usage.messageCounts?.toolResults ?? 0)}
      ${t("usage.overview.toolResults")}`,
    },
    {
      labelKey: "usage.details.duration",
      value: formatDurationCompact(usage.durationMs) ?? t("usage.common.emptyValue"),
      meta: html`${formatTs(usage.firstActivity)} → ${formatTs(usage.lastActivity)}`,
    },
  ];

  return html`
    ${
      badges.length > 0
        ? html`<div class="usage-badges">
            ${badges.map((b) => html`<span class="settings-row__value">${b}</span>`)}
          </div>`
        : nothing
    }
    <div class="session-summary-grid">
      ${cards.map(
        ({ labelKey, value, meta }) => html`
          <div class="stat session-summary-card">
            <div class="session-summary-title">${t(labelKey)}</div>
            <div class="stat-value session-summary-value">${value}</div>
            <div class="session-summary-meta">${meta}</div>
          </div>
        `,
      )}
    </div>
    <div class="usage-insights-grid usage-insights-grid--tight">
      ${renderInsightList(t("usage.overview.topTools"), toolItems, t("usage.overview.noToolCalls"))}
      ${renderInsightList(t("usage.details.modelMix"), modelItems, t("usage.overview.noModelData"))}
    </div>
  `;
}
