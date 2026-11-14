import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { createMemo, For, Show } from "solid-js";
import "../../components/tooltip.ts";
import { Icon } from "../../components/solid/icon.tsx";
import { shouldHandleNavigationClick } from "../../lib/navigation-click.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { parseSessionLog, prepareUsageDateRange } from "./helpers.ts";
import { charsToTokens, formatUsageCost, formatUsageTokens } from "./metrics.ts";
import { renderUsageRefreshStatus } from "./page-shell.tsx";
import { createUsageRead, UsagePending, UsageReadStatus } from "./read-status.tsx";
import type { UsageContextDetail, UsageProps, UsageSessionEntry } from "./types.ts";
import { renderSessionSummary } from "./view-session-summary.tsx";
import { deriveTimeSeries, TimeSeriesCompact } from "./view-timeseries.tsx";

function pct(part: number, total: number): number {
  return total > 0 ? (part / total) * 100 : 0;
}

export function SessionDetailPanel(props: {
  session: UsageSessionEntry;
  detail: UsageProps["detail"];
  callbacks: UsageProps["callbacks"]["details"];
  range: Pick<UsageProps["filters"], "startDate" | "endDate" | "selectedDays" | "timeZone">;
  contextExpanded: boolean;
  onClose: () => void;
}) {
  const logsRead = createUsageRead(
    () => props.detail.sessionLogsRead,
    () => props.detail.sessionLogsStatus.error,
  );
  const logsSource = createMemo(() => props.detail.sessionLogs);
  const entries = createMemo(() => (logsSource() ?? []).map(parseSessionLog));
  const rangeInputs = createMemo(
    () => ({
      startDate: props.range.startDate,
      endDate: props.range.endDate,
      selectedDays: props.range.selectedDays,
      timeZone: props.range.timeZone,
    }),
    {
      equals: (previous, next) =>
        previous.startDate === next.startDate &&
        previous.endDate === next.endDate &&
        previous.selectedDays === next.selectedDays &&
        previous.timeZone === next.timeZone,
    },
  );
  const range = createMemo(() => prepareUsageDateRange(rangeInputs()));
  const seriesInputs = createMemo(
    () => ({
      timeSeries: props.detail.timeSeries,
      timeSeriesStatus: props.detail.timeSeriesStatus,
      timeSeriesMode: props.detail.timeSeriesMode,
      timeSeriesBreakdownMode: props.detail.timeSeriesBreakdownMode,
      timeSeriesCursorStart: props.detail.timeSeriesCursorStart,
      timeSeriesCursorEnd: props.detail.timeSeriesCursorEnd,
      usage: props.session.usage,
    }),
    {
      equals: (previous, next) =>
        previous.timeSeries === next.timeSeries &&
        previous.timeSeriesStatus === next.timeSeriesStatus &&
        previous.timeSeriesMode === next.timeSeriesMode &&
        previous.timeSeriesBreakdownMode === next.timeSeriesBreakdownMode &&
        previous.timeSeriesCursorStart === next.timeSeriesCursorStart &&
        previous.timeSeriesCursorEnd === next.timeSeriesCursorEnd &&
        previous.usage === next.usage,
    },
  );
  const series = createMemo(() => deriveTimeSeries(seriesInputs(), range(), seriesInputs().usage));
  const intervalEntries = createMemo(() => {
    const { timeSeriesCursorStart: start, timeSeriesCursorEnd: end } = props.detail;
    if (start === null || end === null) {
      return entries();
    }
    const low = Math.min(start, end);
    const high = Math.max(start, end);
    const matches = range().matches;
    return entries().filter(({ log }) => {
      // Keep undated entries visible; interval totals count dated entries separately.
      if (!(log.timestamp > 0)) {
        return true;
      }
      // Log timestamps can be seconds or milliseconds.
      const timestamp = log.timestamp < 1e12 ? log.timestamp * 1000 : log.timestamp;
      return timestamp >= low && timestamp <= high && (!matches || matches(timestamp));
    });
  });
  const state = createMemo(() => {
    const session = props.session;
    const detail = props.detail;
    const label = session.label || session.key;
    const displayLabel = label.length > 50 ? truncateUtf16Safe(label, 50) + "…" : label;
    const usage = session.usage;
    const { timeSeriesCursorStart, timeSeriesCursorEnd } = detail;

    const hasRange = timeSeriesCursorStart !== null && timeSeriesCursorEnd !== null;
    const filteredUsage = series().filteredUsage;
    const headerStats = filteredUsage
      ? { totalTokens: filteredUsage.totalTokens, totalCost: filteredUsage.totalCost }
      : { totalTokens: usage?.totalTokens ?? 0, totalCost: usage?.totalCost ?? 0 };
    const cursorIndicator = filteredUsage ? t("usage.details.filtered") : "";

    const filteredLogs = hasRange
      ? detail.sessionLogsStatus.hasLoaded && detail.sessionLogs
        ? intervalEntries()
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
        <Show when={props.detail.conversationHref}>
          {(href) => (
            <a
              class="btn btn--sm"
              href={href()}
              onClick={(event) => {
                if (shouldHandleNavigationClick(event)) {
                  event.preventDefault();
                  props.callbacks.onOpenConversation();
                }
              }}
            >
              {t("usage.details.openConversation")}
            </a>
          )}
        </Show>
        <button
          class="btn btn--sm btn--ghost session-detail-close"
          onClick={() => props.onClose()}
          aria-label={t("usage.details.close")}
        >
          <Icon name="x" />
        </button>
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
          <TimeSeriesCompact detail={props.detail} callbacks={props.callbacks} view={series()} />
        </div>
        <UsageReadStatus read={logsRead}>
          {() =>
            renderUsageRefreshStatus(
              props.detail.sessionLogsStatus,
              "usage.details.intervalCounts",
              "interval-counts",
            )
          }
        </UsageReadStatus>
        <ContextPanel
          context={props.detail.context}
          usage={props.session.usage}
          expanded={props.contextExpanded}
          onToggleExpanded={props.callbacks.onToggleContextExpanded}
        />
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
  const read = createUsageRead(
    () => props.context.read,
    () => props.context.status.error,
  );
  function ContextContent(content: { loading: boolean }) {
    const status = () => (
      <UsageReadStatus read={read}>
        {() =>
          renderUsageRefreshStatus(
            props.context.status,
            "usage.details.systemPromptBreakdown",
            "context",
          )
        }
      </UsageReadStatus>
    );
    function LoadedContextPanel(loaded: { weight: NonNullable<UsageContextDetail["weight"]> }) {
      const state = createMemo(() => {
        const contextWeight = loaded.weight;
        const usage = props.usage;
        const injectedFileChars = contextWeight.injectedWorkspaceFiles.reduce(
          (sum, file) =>
            file.injectionStatus === "native_unverified" ? sum : sum + file.injectedChars,
          0,
        );
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
            tokens: charsToTokens(injectedFileChars),
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
            tokens: charsToTokens(
              Math.max(
                0,
                contextWeight.systemPrompt.chars -
                  injectedFileChars -
                  contextWeight.skills.promptChars -
                  contextWeight.tools.listChars,
              ),
            ),
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
          {status()}
          <div class="context-breakdown-header">
            <div class="card-title usage-section-title">
              {t("usage.details.systemPromptBreakdown")}
            </div>
            <Show when={state().hasMore}>
              <button
                class="btn btn--sm"
                aria-expanded={props.expanded ? "true" : "false"}
                onClick={() => props.onToggleExpanded()}
              >
                {props.expanded ? t("usage.details.collapse") : t("usage.details.expandAll")}
              </button>
            </Show>
          </div>
          <p class="context-weight-desc">{state().contextDescription}</p>
          <div class="context-stacked-bar">
            <For each={state().categories}>
              {({ className, labelKey, tokens }) => (
                <div
                  class={["context-segment", className]}
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
                  <span class={["legend-dot", className]} />
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

    return (
      <Show
        when={props.context.weight}
        fallback={
          <div class="context-details-panel">
            {status()}
            {props.context.status.error ? undefined : (
              <div class="usage-empty-block">
                {t(
                  content.loading || props.context.status.awaitingGateway
                    ? "usage.loading.badge"
                    : "usage.details.noContextData",
                )}
              </div>
            )}
          </div>
        }
      >
        {(weight) => <LoadedContextPanel weight={weight()} />}
      </Show>
    );
  }

  return (
    <UsagePending read={read}>{(loading) => <ContextContent loading={loading()} />}</UsagePending>
  );
}
