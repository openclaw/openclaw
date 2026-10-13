import { expectDefined } from "@openclaw/normalization-core";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { createMemo, For, Show } from "solid-js";
import { Icon } from "../../components/solid/icon.tsx";
import { createMsFormatter } from "../../lib/format.ts";
import "../../components/tooltip.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { parseToolSummary } from "./helpers.ts";
import { charsToTokens, formatUsageCost, formatUsageTokens } from "./metrics.ts";
import { renderUsageRefreshStatus } from "./page-shell.tsx";
import type {
  SessionLogEntry,
  SessionLogRole,
  TimeSeriesPoint,
  UsageContextDetail,
  UsageProps,
  UsageSessionEntry,
} from "./types.ts";
import { USAGE_TOKEN_CATEGORIES } from "./view-chart.tsx";
import { renderSessionSummary } from "./view-session-summary.tsx";
import { TimeSeriesCompact } from "./view-timeseries.tsx";

function pct(part: number, total: number): number {
  return total > 0 ? (part / total) * 100 : 0;
}

function isLogInRange(log: SessionLogEntry, rangeStart: number, rangeEnd: number): boolean {
  // Keep undated entries visible; interval totals count dated entries separately.
  if (!(log.timestamp > 0)) {
    return true;
  }
  // Log timestamps can be seconds or milliseconds.
  const timestamp = log.timestamp;
  const ts = timestamp < 1e12 ? timestamp * 1000 : timestamp;
  return ts >= Math.min(rangeStart, rangeEnd) && ts <= Math.max(rangeStart, rangeEnd);
}

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

export function SessionDetailPanel(props: {
  session: UsageSessionEntry;
  detail: UsageProps["detail"];
  callbacks: UsageProps["callbacks"]["details"];
  range: Pick<UsageProps["filters"], "startDate" | "endDate" | "selectedDays" | "timeZone">;
  contextExpanded: boolean;
  onClose: () => void;
}) {
  const state = createMemo(() => {
    const session = props.session;
    const detail = props.detail;
    const label = session.label || session.key;
    const displayLabel = label.length > 50 ? truncateUtf16Safe(label, 50) + "…" : label;
    const usage = session.usage;
    const { timeSeriesCursorStart, timeSeriesCursorEnd } = detail;

    const hasRange = timeSeriesCursorStart !== null && timeSeriesCursorEnd !== null;
    const filteredUsage =
      hasRange && detail.timeSeries?.points && usage
        ? computeFilteredUsage(
            usage,
            detail.timeSeries.points,
            timeSeriesCursorStart,
            timeSeriesCursorEnd,
          )
        : undefined;
    const headerStats = filteredUsage
      ? { totalTokens: filteredUsage.totalTokens, totalCost: filteredUsage.totalCost }
      : { totalTokens: usage?.totalTokens ?? 0, totalCost: usage?.totalCost ?? 0 };
    const cursorIndicator = filteredUsage ? t("usage.details.filtered") : "";

    const filteredLogs = hasRange
      ? detail.sessionLogsStatus.hasLoaded && detail.sessionLogs
        ? detail.sessionLogs.filter((log) =>
            isLogInRange(log, timeSeriesCursorStart, timeSeriesCursorEnd),
          )
        : null
      : undefined;
    const includedSessionCount =
      session.scope === "family" ? (session.includedSessionIds?.length ?? 0) : 0;
    return {
      includedSessionCount,
      filteredLogs,
      displayLabel,
      cursorIndicator,
      headerStats,
      filteredUsage,
    };
  });
  return (
    <div class="settings-group usage-panel session-detail-panel">
      <div class="session-detail-header">
        <div class="session-detail-header-left">
          <div class="session-detail-title">
            {state().displayLabel}
            {state().cursorIndicator ? (
              <>
                {" "}
                <span class="session-detail-indicator">{state().cursorIndicator}</span>{" "}
              </>
            ) : undefined}
          </div>
        </div>
        <div class="session-detail-stats">
          {props.session.usage ? (
            <>
              <span>
                <strong>{formatUsageTokens(state().headerStats.totalTokens)}</strong>{" "}
                {normalizeLowercaseStringOrEmpty(t("usage.metrics.tokens"))}
                {state().cursorIndicator}
              </span>
              <span>
                <strong>{formatUsageCost(state().headerStats.totalCost)}</strong>
                {state().cursorIndicator}
              </span>
            </>
          ) : undefined}
        </div>
        <openclaw-tooltip prop:content={t("usage.details.close")}>
          <button
            class="btn btn--sm btn--ghost session-detail-close"
            onClick={() => props.onClose()}
            aria-label={t("usage.details.close")}
          >
            <Icon name="x" />
          </button>
        </openclaw-tooltip>
      </div>
      {state().includedSessionCount > 0 ? (
        <div class="usage-lineage-note">
          {t("usage.scope.familyIncluded", {
            count: String(state().includedSessionCount),
          })}
        </div>
      ) : undefined}
      <div class="session-detail-content">
        {renderSessionSummary(props.session, state().filteredUsage, state().filteredLogs)}
        <div class="session-detail-row">
          <TimeSeriesCompact
            detail={props.detail}
            callbacks={props.callbacks}
            range={props.range}
          />
        </div>
        <div class="session-detail-bottom">
          <SessionLogs detail={props.detail} callbacks={props.callbacks} />
          {
            <ContextPanel
              context={props.detail.context}
              usage={props.session.usage}
              expanded={props.contextExpanded}
              onToggleExpanded={props.callbacks.onToggleContextExpanded}
            />
          }
        </div>
      </div>
    </div>
  );
}

function ContextPanel(props: {
  context: UsageContextDetail;
  usage: UsageSessionEntry["usage"];
  expanded: boolean;
  onToggleExpanded: () => void;
}) {
  return (
    <Show
      when={props.context.weight}
      fallback={
        <div class="context-details-panel">
          {renderUsageRefreshStatus(
            props.context.status,
            "usage.details.systemPromptBreakdown",
            "context",
          )}
          {props.context.status.error ? undefined : (
            <div class="usage-empty-block">
              {t(
                props.context.loading || props.context.status.awaitingGateway
                  ? "usage.loading.badge"
                  : "usage.details.noContextData",
              )}
            </div>
          )}
        </div>
      }
    >
      {(weight) => (
        <LoadedContextPanel
          weight={weight()}
          status={props.context.status}
          usage={props.usage}
          expanded={props.expanded}
          onToggleExpanded={props.onToggleExpanded}
        />
      )}
    </Show>
  );
}

function LoadedContextPanel(props: {
  weight: NonNullable<UsageContextDetail["weight"]>;
  status: UsageContextDetail["status"];
  usage: UsageSessionEntry["usage"];
  expanded: boolean;
  onToggleExpanded: () => void;
}) {
  const state = createMemo(() => {
    const contextWeight = props.weight;
    const usage = props.usage;
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

    return {
      hasMore,
      contextDescription,
      categories,
      totalContextTokens,
      groups,
      defaultLimit,
    };
  });
  return (
    <div class="context-details-panel">
      {renderUsageRefreshStatus(props.status, "usage.details.systemPromptBreakdown", "context")}
      <div class="context-breakdown-header">
        <div class="card-title usage-section-title">{t("usage.details.systemPromptBreakdown")}</div>
        <Show when={state().hasMore}>
          <button class="btn btn--sm" onClick={() => props.onToggleExpanded()}>
            {props.expanded ? t("usage.details.collapse") : t("usage.details.expandAll")}
          </button>
        </Show>
      </div>
      <p class="context-weight-desc">{state().contextDescription}</p>
      <div class="context-stacked-bar">
        <For each={state().categories}>
          {({ className, labelKey, tokens }) => (
            <div
              class={`context-segment ${className}`}
              style={{ width: `${pct(tokens, state().totalContextTokens).toFixed(1)}%` }}
              title={`${t(labelKey)}: ~${formatUsageTokens(tokens)}`}
            />
          )}
        </For>
      </div>
      <div class="context-legend">
        <For each={state().categories}>
          {({ className, labelKey, tokens }) => (
            <span class="legend-item">
              <span class={`legend-dot ${className}`} />
              {t(className === "system" ? "usage.details.systemShort" : labelKey)} ~
              {formatUsageTokens(tokens)}
            </span>
          )}
        </For>
      </div>
      <div class="context-total">
        {t("usage.breakdown.total")}: ~{formatUsageTokens(state().totalContextTokens)}
      </div>
      <div class="context-breakdown-grid">
        <For each={state().groups.filter(({ entries }) => entries.length > 0)}>
          {({ labelKey, entries }) => {
            const visible = createMemo(() =>
              props.expanded ? entries : entries.slice(0, state().defaultLimit),
            );
            const more = () => entries.length - visible().length;
            return (
              <div class="context-breakdown-card">
                <div class="context-breakdown-title">
                  {t(labelKey)} ({entries.length})
                </div>
                <div class="context-breakdown-list">
                  <For each={visible()}>
                    {({ name, chars }) => (
                      <div class="context-breakdown-item">
                        <span class="mono" title={name}>
                          {name}
                        </span>
                        <span class="muted">
                          {chars === null
                            ? t("usage.common.unknown")
                            : `~${formatUsageTokens(charsToTokens(chars))}`}
                        </span>
                      </div>
                    )}
                  </For>
                </div>
                {more() > 0 ? (
                  <div class="context-breakdown-more">
                    {t("usage.sessions.more", { count: String(more()) })}
                  </div>
                ) : undefined}
              </div>
            );
          }}
        </For>
      </div>
    </div>
  );
}

const SESSION_LOG_ROLES = [
  ["user", "usage.overview.user"],
  ["assistant", "usage.overview.assistant"],
  ["tool", "usage.details.tool"],
  ["toolResult", "usage.details.toolResult"],
] as const;

function isSessionLogRole(value: string): value is SessionLogRole {
  return SESSION_LOG_ROLES.some(([role]) => role === value);
}

function selectedLogFilterValues(select: HTMLSelectElement): string[] {
  return Array.from(select.selectedOptions, (option) => option.value);
}

function SessionLogs(props: {
  detail: UsageProps["detail"];
  callbacks: UsageProps["callbacks"]["details"];
}) {
  const logsSource = createMemo(() => props.detail.sessionLogs);
  const entries = createMemo(() =>
    (logsSource() ?? []).map((log) => {
      const toolInfo = parseToolSummary(log.content);
      const cleanContent = toolInfo.cleanContent || log.content;
      return { log, toolInfo, cleanContent };
    }),
  );
  const expandedState = createMemo(() => props.detail.sessionLogsExpanded);
  const state = createMemo(() => {
    const detail = props.detail;
    const {
      sessionLogsLoading: loading,
      sessionLogsStatus: status,
      logFilters: filters,
      timeSeriesCursorStart: cursorStart,
      timeSeriesCursorEnd: cursorEnd,
    } = detail;
    const logs = logsSource();
    const parsedEntries = entries();
    const initialLoading = (loading || status.awaitingGateway) && !status.hasLoaded;
    const initialError = status.error && !status.hasLoaded;
    const refreshStatus = initialLoading
      ? undefined
      : renderUsageRefreshStatus(status, "usage.details.conversation", "conversation");
    const showLogData = !initialLoading && !initialError && Boolean(logs?.length);
    const message = initialLoading ? "usage.loading.badge" : "usage.details.noMessages";

    const formatLogTimestamp = createMsFormatter();
    const normalizedQuery = normalizeLowercaseStringOrEmpty(filters.query);
    const toolOptions = Array.from(
      new Set(parsedEntries.flatMap((entry) => entry.toolInfo.tools.map(([name]) => name))),
    ).toSorted((a, b) => a.localeCompare(b));
    const hasCursorFilter = cursorStart != null && cursorEnd != null;
    const filteredEntries = parsedEntries.filter(
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
        ? `${filteredEntries.length} ${t("usage.details.of")} ${logs?.length ?? 0}${hasCursorFilter ? ` (${t("usage.details.timelineFiltered")})` : ""}`
        : `${logs?.length ?? 0}`;

    const roleSelected = new Set(filters.roles);
    const toolSelected = new Set(filters.tools);

    return {
      showLogData,
      displayedCount,
      refreshStatus,
      roleSelected,
      toolOptions,
      toolSelected,
      filteredEntries,
      formatLogTimestamp,
      initialLoading,
      initialError,
      message,
    };
  });
  return (
    <>
      {state().showLogData ? (
        <div class="session-logs-compact">
          <div class="session-logs-header">
            <span>
              {t("usage.details.conversation")}{" "}
              <span class="session-logs-header-count">
                ({state().displayedCount}{" "}
                {normalizeLowercaseStringOrEmpty(t("usage.overview.messages"))})
              </span>
            </span>
            <button
              class="btn btn--sm"
              onClick={() => props.callbacks.onToggleSessionLogsExpanded()}
            >
              {props.detail.sessionLogsExpanded
                ? t("usage.details.collapseAll")
                : t("usage.details.expandAll")}
            </button>
          </div>
          {state().refreshStatus}
          <div class="usage-filters-inline session-log-filters">
            <select
              multiple
              size="4"
              aria-label={t("usage.details.filterByRole")}
              onChange={(event) =>
                props.callbacks.onLogFiltersChange({
                  roles: selectedLogFilterValues(event.currentTarget).filter(isSessionLogRole),
                })
              }
            >
              <For each={SESSION_LOG_ROLES}>
                {([role, labelKey]) => (
                  <>
                    {" "}
                    <option value={role} selected={state().roleSelected.has(role)}>
                      {t(labelKey)}
                    </option>{" "}
                  </>
                )}
              </For>
            </select>
            <select
              multiple
              size="4"
              aria-label={t("usage.details.filterByTool")}
              onChange={(event) =>
                props.callbacks.onLogFiltersChange({
                  tools: selectedLogFilterValues(event.currentTarget),
                })
              }
            >
              <For each={state().toolOptions}>
                {(tool) => (
                  <>
                    {" "}
                    <option value={tool} selected={state().toolSelected.has(tool)}>
                      {tool}
                    </option>{" "}
                  </>
                )}
              </For>
            </select>
            <label class="usage-filters-inline session-log-has-tools">
              <input
                type="checkbox"
                checked={props.detail.logFilters.hasTools}
                onChange={(event) =>
                  props.callbacks.onLogFiltersChange({ hasTools: event.currentTarget.checked })
                }
              />
              {t("usage.details.hasTools")}
            </label>
            <input
              type="text"
              placeholder={t("usage.details.searchConversation")}
              aria-label={t("usage.details.searchConversation")}
              value={props.detail.logFilters.query}
              onInput={(event) =>
                props.callbacks.onLogFiltersChange({ query: event.currentTarget.value })
              }
            />
            <button
              class="btn btn--sm"
              onClick={() =>
                props.callbacks.onLogFiltersChange({
                  roles: [],
                  tools: [],
                  hasTools: false,
                  query: "",
                })
              }
            >
              {t("usage.filters.clear")}
            </button>
          </div>
          <div class="session-logs-list">
            <For each={state().filteredEntries}>
              {(entry) => {
                const { log, toolInfo, cleanContent } = entry;
                const roleClass = log.role === "user" ? "user" : "assistant";
                const roleLabel = () =>
                  log.role === "user"
                    ? t("usage.details.you")
                    : log.role === "assistant"
                      ? t("usage.overview.assistant")
                      : t("usage.details.tool");
                return (
                  <div class={`session-log-entry ${roleClass}`}>
                    <div class="session-log-meta">
                      <span class="session-log-role">{roleLabel()}</span>
                      <span>{state().formatLogTimestamp(log.timestamp)}</span>
                      {log.tokens ? (
                        <>
                          {" "}
                          <span>{formatUsageTokens(log.tokens)}</span>{" "}
                        </>
                      ) : undefined}
                    </div>
                    <div class="session-log-content">{cleanContent}</div>
                    {toolInfo.tools.length > 0 ? (
                      <details class="session-log-tools" open={expandedState()}>
                        <summary>{toolInfo.summary}</summary>
                        <div class="session-log-tools-list">
                          <For each={toolInfo.tools}>
                            {([name, count]) => (
                              <span class="session-log-tools-pill">
                                {name} × {count}
                              </span>
                            )}
                          </For>
                        </div>
                      </details>
                    ) : undefined}
                  </div>
                );
              }}
            </For>
            {state().filteredEntries.length === 0 ? (
              <div class="usage-empty-block usage-empty-block--compact">
                {t("usage.details.noMessagesMatch")}
              </div>
            ) : undefined}
          </div>
        </div>
      ) : (
        <div class="session-logs-compact">
          <div class="session-logs-header">{t("usage.details.conversation")}</div>
          {state().refreshStatus}
          {state().initialLoading || !state().initialError ? (
            <div class="usage-empty-block">{t(state().message)}</div>
          ) : undefined}
        </div>
      )}
    </>
  );
}
