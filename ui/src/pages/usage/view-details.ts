import { expectDefined } from "@openclaw/normalization-core";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { html, nothing } from "lit";
import type { PanelRefreshStatus } from "../../components/panel-refresh-status.ts";
import { t } from "../../i18n/index.ts";
import "../../components/tooltip.ts";
import { createMsFormatter } from "../../lib/format.ts";
import { parseToolSummary } from "./helpers.ts";
import { charsToTokens, formatUsageCost, formatUsageTokens } from "./metrics.ts";
import { renderUsageRefreshStatus } from "./page-shell.ts";
import type {
  SessionLogEntry,
  SessionLogRole,
  TimeSeriesPoint,
  UsageContextDetail,
  UsageSessionEntry,
} from "./types.ts";
import { USAGE_TOKEN_CATEGORIES } from "./view-chart.ts";
import { renderSessionSummary } from "./view-session-summary.ts";
import { renderTimeSeriesCompact } from "./view-timeseries.ts";

function pct(part: number, total: number): number {
  return total > 0 ? (part / total) * 100 : 0;
}

/** Normalize a log timestamp to milliseconds (handles seconds vs ms). */
function normalizeLogTimestamp(ts: number): number {
  return ts < 1e12 ? ts * 1000 : ts;
}

function isLogInRange(log: SessionLogEntry, rangeStart: number, rangeEnd: number): boolean {
  // Keep undated entries visible; interval totals count dated entries separately.
  if (!(log.timestamp > 0)) {
    return true;
  }
  const ts = normalizeLogTimestamp(log.timestamp);
  return ts >= Math.min(rangeStart, rangeEnd) && ts <= Math.max(rangeStart, rangeEnd);
}

/** Aggregate usage stats from time series points within a timestamp range. */
function computeFilteredUsage(
  baseUsage: NonNullable<UsageSessionEntry["usage"]>,
  points: TimeSeriesPoint[],
  rangeStart: number,
  rangeEnd: number,
): UsageSessionEntry["usage"] | undefined {
  const lo = Math.min(rangeStart, rangeEnd);
  const hi = Math.max(rangeStart, rangeEnd);
  const filtered = points.filter((p) => p.timestamp >= lo && p.timestamp <= hi);
  if (filtered.length === 0) {
    return undefined;
  }

  let totalTokens = 0;
  let totalCost = 0;
  const tokenTotals = { output: 0, input: 0, cacheWrite: 0, cacheRead: 0 };

  for (const p of filtered) {
    totalTokens += p.totalTokens || 0;
    totalCost += p.cost || 0;
    for (const { key } of USAGE_TOKEN_CATEGORIES) {
      tokenTotals[key] += p[key] || 0;
    }
  }
  const first = expectDefined(filtered[0], "filtered usage first point");
  const last = expectDefined(filtered.at(-1), "filtered usage last point");

  return {
    ...baseUsage,
    ...tokenTotals,
    totalTokens,
    totalCost,
    durationMs: last.timestamp - first.timestamp,
    firstActivity: first.timestamp,
    lastActivity: last.timestamp,
    messageCounts: undefined,
  };
}

function renderSessionDetailPanel(
  session: UsageSessionEntry,
  timeSeries: { points: TimeSeriesPoint[] } | null,
  timeSeriesLoading: boolean,
  timeSeriesStatus: PanelRefreshStatus,
  timeSeriesMode: "cumulative" | "per-turn",
  onTimeSeriesModeChange: (mode: "cumulative" | "per-turn") => void,
  timeSeriesBreakdownMode: "total" | "by-type",
  onTimeSeriesBreakdownChange: (mode: "total" | "by-type") => void,
  timeSeriesCursorStart: number | null,
  timeSeriesCursorEnd: number | null,
  onTimeSeriesCursorRangeChange: (start: number | null, end: number | null) => void,
  startDate: string,
  endDate: string,
  selectedDays: string[],
  timeZone: "local" | "utc",
  sessionLogs: SessionLogEntry[] | null,
  sessionLogsLoading: boolean,
  sessionLogsStatus: PanelRefreshStatus,
  sessionLogsExpanded: boolean,
  onToggleSessionLogsExpanded: () => void,
  logFilters: {
    roles: SessionLogRole[];
    tools: string[];
    hasTools: boolean;
    query: string;
  },
  onLogFilterRolesChange: (next: SessionLogRole[]) => void,
  onLogFilterToolsChange: (next: string[]) => void,
  onLogFilterHasToolsChange: (next: boolean) => void,
  onLogFilterQueryChange: (next: string) => void,
  onLogFilterClear: () => void,
  context: UsageContextDetail,
  contextExpanded: boolean,
  onToggleContextExpanded: () => void,
  onClose: () => void,
) {
  const label = session.label || session.key;
  const displayLabel = label.length > 50 ? truncateUtf16Safe(label, 50) + "…" : label;
  const usage = session.usage;

  const hasRange = timeSeriesCursorStart !== null && timeSeriesCursorEnd !== null;
  const filteredUsage =
    timeSeriesCursorStart !== null && timeSeriesCursorEnd !== null && timeSeries?.points && usage
      ? computeFilteredUsage(usage, timeSeries.points, timeSeriesCursorStart, timeSeriesCursorEnd)
      : undefined;
  const headerStats = filteredUsage
    ? { totalTokens: filteredUsage.totalTokens, totalCost: filteredUsage.totalCost }
    : { totalTokens: usage?.totalTokens ?? 0, totalCost: usage?.totalCost ?? 0 };
  const cursorIndicator = filteredUsage ? t("usage.details.filtered") : "";

  return html`
    <div class="settings-group usage-panel session-detail-panel">
      <div class="session-detail-header">
        <div class="session-detail-header-left">
          <div class="session-detail-title">
            ${displayLabel}
            ${
              cursorIndicator
                ? html`<span class="session-detail-indicator">${cursorIndicator}</span>`
                : nothing
            }
          </div>
        </div>
        <div class="session-detail-stats">
          ${
            usage
              ? html`
                  <span
                    ><strong>${formatUsageTokens(headerStats.totalTokens)}</strong>
                    ${normalizeLowercaseStringOrEmpty(
                      t("usage.metrics.tokens"),
                    )}${cursorIndicator}</span
                  >
                  <span
                    ><strong>${formatUsageCost(headerStats.totalCost)}</strong
                    >${cursorIndicator}</span
                  >
                `
              : nothing
          }
        </div>
        <openclaw-tooltip .content=${t("usage.details.close")}>
          <button
            class="btn btn--sm btn--ghost"
            @click=${onClose}
            aria-label=${t("usage.details.close")}
          >
            ×
          </button>
        </openclaw-tooltip>
      </div>
      ${
        session.scope === "family" && session.includedSessionIds?.length
          ? html`
              <div class="usage-lineage-note">
                ${t("usage.scope.familyIncluded", {
                  count: String(session.includedSessionIds.length),
                })}
              </div>
            `
          : nothing
      }
      <div class="session-detail-content">
        ${renderSessionSummary(
          session,
          filteredUsage,
          hasRange
            ? sessionLogsStatus.hasLoaded && sessionLogs
              ? sessionLogs.filter((log) =>
                  isLogInRange(log, timeSeriesCursorStart, timeSeriesCursorEnd),
                )
              : null
            : undefined,
        )}
        <div class="session-detail-row">
          ${renderTimeSeriesCompact(
            timeSeries,
            timeSeriesLoading,
            timeSeriesStatus,
            timeSeriesMode,
            onTimeSeriesModeChange,
            timeSeriesBreakdownMode,
            onTimeSeriesBreakdownChange,
            startDate,
            endDate,
            selectedDays,
            timeZone,
            timeSeriesCursorStart,
            timeSeriesCursorEnd,
            onTimeSeriesCursorRangeChange,
          )}
        </div>
        <div class="session-detail-bottom">
          ${renderSessionLogsCompact(
            sessionLogs,
            sessionLogsLoading,
            sessionLogsStatus,
            sessionLogsExpanded,
            onToggleSessionLogsExpanded,
            logFilters,
            onLogFilterRolesChange,
            onLogFilterToolsChange,
            onLogFilterHasToolsChange,
            onLogFilterQueryChange,
            onLogFilterClear,
            hasRange ? timeSeriesCursorStart : null,
            hasRange ? timeSeriesCursorEnd : null,
          )}
          ${renderContextPanel(context, usage, contextExpanded, onToggleContextExpanded)}
        </div>
      </div>
    </div>
  `;
}

function renderContextPanel(
  { weight: contextWeight, loading, status }: UsageContextDetail,
  usage: UsageSessionEntry["usage"],
  expanded: boolean,
  onToggleExpanded: () => void,
) {
  const refreshStatus = renderUsageRefreshStatus(
    status,
    "usage.details.systemPromptBreakdown",
    "context",
  );
  if (!contextWeight) {
    return html`
      <div class="context-details-panel">
        ${refreshStatus}
        ${
          status.error
            ? nothing
            : html`<div class="usage-empty-block">
                ${t(loading || status.awaitingGateway ? "usage.loading.badge" : "usage.details.noContextData")}
              </div>`
        }
      </div>
    `;
  }
  const groups = [
    {
      className: "skills",
      labelKey: "usage.details.skills",
      tokens: charsToTokens(contextWeight.skills.promptChars),
      entries: contextWeight.skills.entries.map(({ name, blockChars }) => ({
        name,
        chars: blockChars,
      })),
    },
    {
      className: "tools",
      labelKey: "usage.details.tools",
      tokens: charsToTokens(contextWeight.tools.listChars + contextWeight.tools.schemaChars),
      entries: contextWeight.tools.entries.map(({ name, summaryChars, schemaChars }) => ({
        name,
        chars: summaryChars + schemaChars,
      })),
    },
    {
      className: "files",
      labelKey: "usage.details.files",
      tokens: charsToTokens(
        contextWeight.injectedWorkspaceFiles.reduce(
          (sum, file) =>
            file.injectionStatus === "native_unverified" ? sum : sum + file.injectedChars,
          0,
        ),
      ),
      entries: contextWeight.injectedWorkspaceFiles.map(({ name, injectedChars }) => ({
        name,
        chars: injectedChars,
      })),
    },
  ].map(({ className, labelKey, tokens, entries }) => ({
    className,
    labelKey,
    tokens,
    entries: entries.toSorted((left, right) => {
      if (left.chars === null) {
        return right.chars === null ? 0 : 1;
      }
      return right.chars === null ? -1 : right.chars - left.chars;
    }),
  }));
  const categories = [
    {
      className: "system",
      labelKey: "usage.details.system",
      tokens: charsToTokens(contextWeight.systemPrompt.chars),
    },
    ...groups,
  ];
  const totalContextTokens = categories.reduce((sum, { tokens }) => sum + tokens, 0);
  const inputTokens = usage && usage.totalTokens > 0 ? usage.input + usage.cacheRead : 0;
  const contextDescription =
    inputTokens > 0
      ? `~${Math.min((totalContextTokens / inputTokens) * 100, 100).toFixed(0)}% ${t("usage.details.ofInput")}`
      : t("usage.details.baseContextPerMessage");
  const defaultLimit = 4;
  const hasMore = groups.some(({ entries }) => entries.length > defaultLimit);

  return html`
    <div class="context-details-panel">
      ${refreshStatus}
      <div class="context-breakdown-header">
        <div class="card-title usage-section-title">
          ${t("usage.details.systemPromptBreakdown")}
        </div>
        ${
          hasMore
            ? html`<button class="btn btn--sm" @click=${onToggleExpanded}>
                ${expanded ? t("usage.details.collapse") : t("usage.details.expandAll")}
              </button>`
            : nothing
        }
      </div>
      <p class="context-weight-desc">${contextDescription}</p>
      <div class="context-stacked-bar">
        ${categories.map(
          ({ className, labelKey, tokens }) => html`
            <div
              class="context-segment ${className}"
              style="width: ${pct(tokens, totalContextTokens).toFixed(1)}%"
              title="${t(labelKey)}: ~${formatUsageTokens(tokens)}"
            ></div>
          `,
        )}
      </div>
      <div class="context-legend">
        ${categories.map(
          ({ className, labelKey, tokens }) => html`
            <span class="legend-item"
              ><span class="legend-dot ${className}"></span>${t(
                className === "system" ? "usage.details.systemShort" : labelKey,
              )}
              ~${formatUsageTokens(tokens)}</span
            >
          `,
        )}
      </div>
      <div class="context-total">
        ${t("usage.breakdown.total")}: ~${formatUsageTokens(totalContextTokens)}
      </div>
      <div class="context-breakdown-grid">
        ${groups
          .filter(({ entries }) => entries.length > 0)
          .map(({ labelKey, entries }) => {
            const visible = expanded ? entries : entries.slice(0, defaultLimit);
            const more = entries.length - visible.length;
            return html`
              <div class="context-breakdown-card">
                <div class="context-breakdown-title">${t(labelKey)} (${entries.length})</div>
                <div class="context-breakdown-list">
                  ${visible.map(
                    ({ name, chars }) => html`
                      <div class="context-breakdown-item">
                        <span class="mono" title=${name}>${name}</span>
                        <span class="muted"
                          >${
                            chars === null
                              ? t("usage.common.unknown")
                              : `~${formatUsageTokens(charsToTokens(chars))}`
                          }</span
                        >
                      </div>
                    `,
                  )}
                </div>
                ${
                  more > 0
                    ? html`
                        <div class="context-breakdown-more">
                          ${t("usage.sessions.more", { count: String(more) })}
                        </div>
                      `
                    : nothing
                }
              </div>
            `;
          })}
      </div>
    </div>
  `;
}

function renderSessionLogsCompact(
  logs: SessionLogEntry[] | null,
  loading: boolean,
  status: PanelRefreshStatus,
  expandedAll: boolean,
  onToggleExpandedAll: () => void,
  filters: {
    roles: SessionLogRole[];
    tools: string[];
    hasTools: boolean;
    query: string;
  },
  onFilterRolesChange: (next: SessionLogRole[]) => void,
  onFilterToolsChange: (next: string[]) => void,
  onFilterHasToolsChange: (next: boolean) => void,
  onFilterQueryChange: (next: string) => void,
  onFilterClear: () => void,
  cursorStart?: number | null,
  cursorEnd?: number | null,
) {
  if ((loading || status.awaitingGateway) && !status.hasLoaded) {
    return html`
      <div class="session-logs-compact">
        <div class="session-logs-header">${t("usage.details.conversation")}</div>
        <div class="usage-empty-block">${t("usage.loading.badge")}</div>
      </div>
    `;
  }
  const refreshStatus = renderUsageRefreshStatus(
    status,
    "usage.details.conversation",
    "conversation",
  );
  if (status.error && !status.hasLoaded) {
    return html`
      <div class="session-logs-compact">
        <div class="session-logs-header">${t("usage.details.conversation")}</div>
        ${refreshStatus}
      </div>
    `;
  }
  if (!logs || logs.length === 0) {
    return html`
      <div class="session-logs-compact">
        <div class="session-logs-header">${t("usage.details.conversation")}</div>
        ${refreshStatus}
        <div class="usage-empty-block">${t("usage.details.noMessages")}</div>
      </div>
    `;
  }

  const formatLogTimestamp = createMsFormatter();
  const normalizedQuery = normalizeLowercaseStringOrEmpty(filters.query);
  const entries = logs.map((log) => {
    const toolInfo = parseToolSummary(log.content);
    const cleanContent = toolInfo.cleanContent || log.content;
    return { log, toolInfo, cleanContent };
  });
  const toolOptions = Array.from(
    new Set(entries.flatMap((entry) => entry.toolInfo.tools.map(([name]) => name))),
  ).toSorted((a, b) => a.localeCompare(b));
  const hasCursorFilter = cursorStart != null && cursorEnd != null;
  const filteredEntries = entries.filter(
    (entry) =>
      (!hasCursorFilter || isLogInRange(entry.log, cursorStart, cursorEnd)) &&
      (filters.roles.length === 0 || filters.roles.includes(entry.log.role)) &&
      (!filters.hasTools || entry.toolInfo.tools.length > 0) &&
      (filters.tools.length === 0 ||
        entry.toolInfo.tools.some(([name]) => filters.tools.includes(name))) &&
      (!normalizedQuery ||
        normalizeLowercaseStringOrEmpty(entry.cleanContent).includes(normalizedQuery)),
  );
  const hasActiveFilters =
    filters.roles.length > 0 || filters.tools.length > 0 || filters.hasTools || normalizedQuery;
  const displayedCount =
    hasActiveFilters || hasCursorFilter
      ? `${filteredEntries.length} ${t("usage.details.of")} ${logs.length}${hasCursorFilter ? ` (${t("usage.details.timelineFiltered")})` : ""}`
      : `${logs.length}`;

  const roleSelected = new Set(filters.roles);
  const toolSelected = new Set(filters.tools);

  return html`
    <div class="session-logs-compact">
      <div class="session-logs-header">
        <span>
          ${t("usage.details.conversation")}
          <span class="session-logs-header-count">
            (${displayedCount} ${normalizeLowercaseStringOrEmpty(t("usage.overview.messages"))})
          </span>
        </span>
        <button class="btn btn--sm" @click=${onToggleExpandedAll}>
          ${expandedAll ? t("usage.details.collapseAll") : t("usage.details.expandAll")}
        </button>
      </div>
      ${refreshStatus}
      <div class="usage-filters-inline session-log-filters">
        <select
          multiple
          size="4"
          aria-label=${t("usage.details.filterByRole")}
          @change=${(event: Event) =>
            onFilterRolesChange(
              Array.from((event.target as HTMLSelectElement).selectedOptions).map(
                (option) => option.value as SessionLogRole,
              ),
            )}
        >
          ${(
            [
              ["user", "usage.overview.user"],
              ["assistant", "usage.overview.assistant"],
              ["tool", "usage.details.tool"],
              ["toolResult", "usage.details.toolResult"],
            ] as const
          ).map(
            ([role, labelKey]) =>
              html`<option value=${role} ?selected=${roleSelected.has(role)}>
                ${t(labelKey)}
              </option>`,
          )}
        </select>
        <select
          multiple
          size="4"
          aria-label=${t("usage.details.filterByTool")}
          @change=${(event: Event) =>
            onFilterToolsChange(
              Array.from((event.target as HTMLSelectElement).selectedOptions).map(
                (option) => option.value,
              ),
            )}
        >
          ${toolOptions.map(
            (tool) =>
              html`<option value=${tool} ?selected=${toolSelected.has(tool)}>${tool}</option>`,
          )}
        </select>
        <label class="usage-filters-inline session-log-has-tools">
          <input
            type="checkbox"
            .checked=${filters.hasTools}
            @change=${(event: Event) =>
              onFilterHasToolsChange((event.target as HTMLInputElement).checked)}
          />
          ${t("usage.details.hasTools")}
        </label>
        <input
          type="text"
          placeholder=${t("usage.details.searchConversation")}
          aria-label=${t("usage.details.searchConversation")}
          .value=${filters.query}
          @input=${(event: Event) => onFilterQueryChange((event.target as HTMLInputElement).value)}
        />
        <button class="btn btn--sm" @click=${onFilterClear}>${t("usage.filters.clear")}</button>
      </div>
      <div class="session-logs-list">
        ${filteredEntries.map((entry) => {
          const { log, toolInfo, cleanContent } = entry;
          const roleClass = log.role === "user" ? "user" : "assistant";
          const roleLabel =
            log.role === "user"
              ? t("usage.details.you")
              : log.role === "assistant"
                ? t("usage.overview.assistant")
                : t("usage.details.tool");
          return html`
            <div class="session-log-entry ${roleClass}">
              <div class="session-log-meta">
                <span class="session-log-role">${roleLabel}</span>
                <span>${formatLogTimestamp(log.timestamp)}</span>
                ${log.tokens ? html`<span>${formatUsageTokens(log.tokens)}</span>` : nothing}
              </div>
              <div class="session-log-content">${cleanContent}</div>
              ${
                toolInfo.tools.length > 0
                  ? html`
                      <details class="session-log-tools" ?open=${expandedAll}>
                        <summary>${toolInfo.summary}</summary>
                        <div class="session-log-tools-list">
                          ${toolInfo.tools.map(
                            ([name, count]) => html`
                              <span class="session-log-tools-pill">${name} × ${count}</span>
                            `,
                          )}
                        </div>
                      </details>
                    `
                  : nothing
              }
            </div>
          `;
        })}
        ${
          filteredEntries.length === 0
            ? html`
                <div class="usage-empty-block usage-empty-block--compact">
                  ${t("usage.details.noMessagesMatch")}
                </div>
              `
            : nothing
        }
      </div>
    </div>
  `;
}

export { renderSessionDetailPanel };
