import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { For, createMemo } from "solid-js";
import { SettingsSection, SettingsSegmented } from "../../components/solid/settings-ui.tsx";
import { formatDurationCompact } from "../../lib/format-duration.ts";
import { t } from "../../lib/reactive/i18n.ts";
import "../../components/tooltip.ts";
import { formatAnalysisCost, formatUsageTokens } from "./metrics.ts";
import type { UsageProps, UsageSessionEntry } from "./types.ts";
import { SessionBarRow } from "./view-session-row.tsx";

const SESSION_SORT_OPTIONS = [
  { value: "cost", labelKey: "usage.metrics.cost" },
  { value: "errors", labelKey: "usage.overview.errors" },
  { value: "messages", labelKey: "usage.overview.messages" },
  { value: "recent", labelKey: "usage.sessions.recentShort" },
  { value: "tokens", labelKey: "usage.metrics.tokens" },
] as const;

const buildSessionMeta = (session: UsageSessionEntry): string[] =>
  [
    session.channel && `channel:${session.channel}`,
    (session.modelProvider || session.providerOverride) &&
      `provider:${session.modelProvider ?? session.providerOverride}`,
    session.model && `model:${session.model}`,
    session.usage?.messageCounts && `msgs:${session.usage.messageCounts.total}`,
    session.usage?.toolUsage && `tools:${session.usage.toolUsage.totalCalls}`,
    session.usage?.messageCounts && `errors:${session.usage.messageCounts.errors}`,
    session.usage?.durationMs && `dur:${formatDurationCompact(session.usage.durationMs) ?? "—"}`,
  ].filter((part): part is string => typeof part === "string" && part.length > 0);

export function SessionsCard(props: {
  sessions: UsageSessionEntry[];
  usage: UsageProps;
  overview?: UsageProps["data"]["sessionPage"];
  loading?: boolean;
  totalSessions: number;
}) {
  const state = createMemo(() => {
    const sessions = props.sessions;
    const filters = props.usage.filters;
    const display = props.usage.display;
    const callbacks = props.usage.callbacks;
    const totalSessions = props.totalSessions;

    const { selectedSessions } = filters;
    const { sessionSort, sessionSortDir, sessionsTab } = display;
    const { onSelectSession } = callbacks.details;
    const onDisplayChange = callbacks.display.onChange;
    const { onClearSessions } = callbacks.filters;
    const isTokenMode = display.chartMode === "tokens";
    const sortDirectionLabel = t(
      sessionSortDir === "desc" ? "usage.sessions.descending" : "usage.sessions.ascending",
    );

    const entries = sessions.map((session) => {
      const usage = session.usage;
      const tokens = usage?.totalTokens ?? 0;
      const cost = usage?.totalCost ?? 0;
      const rawLabel = session.label || session.key;
      // Agent session keys often include a token query param; remove it for readability.
      const displayLabel =
        rawLabel.startsWith("agent:") && rawLabel.includes("?token=")
          ? rawLabel.slice(0, rawLabel.indexOf("?token="))
          : rawLabel;
      return {
        session,
        displayLabel,
        value: isTokenMode ? tokens : cost,
      };
    });
    const count = props.overview?.tableSessionCount ?? 0;
    const totals = props.overview?.tableTotals;
    const totalValue = (isTokenMode ? totals?.tokens : totals?.cost) ?? 0;
    const avgValue = count ? totalValue / count : 0;
    const totalErrors = totals?.errors ?? 0;

    const selectedSet = new Set(selectedSessions);
    const selectedEntries = entries.filter((entry) => selectedSet.has(entry.session.key));
    const selectedCount = selectedEntries.length;
    const displayedEntries = entries;

    return {
      displayedEntries,
      totalSessions,
      isTokenMode,
      avgValue,
      totalErrors,
      sessionsTab,
      onDisplayChange,
      sessionSort,
      sortDirectionLabel,
      sessionSortDir,
      selectedCount,
      onClearSessions,
      selectedSessions,
      onSelectSession,
      sessions,
      selectedEntries,
    };
  });
  return (
    <SettingsSection title={t("usage.sessions.title")}>
      <div class="usage-panel sessions-card">
        <div class="sessions-card-header">
          <div class="sessions-card-count">
            {t("usage.sessions.shown", { count: String(state().displayedEntries.length) })}
            {state().totalSessions !== state().displayedEntries.length
              ? ` · ${t("usage.sessions.total", { count: String(state().totalSessions) })}`
              : ""}
          </div>
        </div>
        <div class="sessions-card-meta">
          <div class="sessions-card-stats">
            <span>
              {state().isTokenMode
                ? formatUsageTokens(state().avgValue)
                : formatAnalysisCost(state().avgValue)}{" "}
              {t("usage.sessions.avg")}
            </span>
            <span>
              {state().totalErrors} {normalizeLowercaseStringOrEmpty(t("usage.overview.errors"))}
            </span>
          </div>
          <SettingsSegmented
            mode="buttons"
            variant="accent"
            ariaPressed={false}
            class="small"
            value={state().sessionsTab}
            onChange={(tab) => state().onDisplayChange({ sessionsTab: tab })}
            onReselect={(tab) => state().onDisplayChange({ sessionsTab: tab })}
            options={[
              { value: "all", label: t("usage.sessions.all") },
              { value: "recent", label: t("usage.sessions.recent") },
            ]}
          />
          <label class="sessions-sort">
            <span>{t("usage.sessions.sort")}</span>
            <select
              class="settings-select"
              onChange={(event) => {
                const selected = SESSION_SORT_OPTIONS.find(
                  (option) => option.value === event.currentTarget.value,
                );
                if (selected) {
                  state().onDisplayChange({ sessionSort: selected.value });
                }
              }}
            >
              <For each={SESSION_SORT_OPTIONS}>
                {({ value, labelKey }) => (
                  <option value={value} selected={state().sessionSort === value}>
                    {t(labelKey)}
                  </option>
                )}
              </For>
            </select>
          </label>
          <openclaw-tooltip prop:content={state().sortDirectionLabel}>
            <button
              class="btn btn--sm"
              aria-label={state().sortDirectionLabel}
              onClick={() =>
                state().onDisplayChange({
                  sessionSortDir: state().sessionSortDir === "desc" ? "asc" : "desc",
                })
              }
            >
              {state().sessionSortDir === "desc" ? "↓" : "↑"}
            </button>
          </openclaw-tooltip>
          {state().selectedCount > 0 ? (
            <button class="btn btn--sm" onClick={() => state().onClearSessions()}>
              {t("usage.sessions.clearSelection")}
            </button>
          ) : undefined}
        </div>
        {state().displayedEntries.length === 0 ? (
          <div class="usage-empty-block">
            {t(
              state().sessionsTab === "recent"
                ? "usage.sessions.noRecent"
                : "usage.sessions.noneInRange",
            )}
          </div>
        ) : (
          <div
            class={
              state().sessionsTab === "recent"
                ? "session-bars session-bars--recent"
                : "session-bars"
            }
          >
            <SessionRows
              entries={state().displayedEntries}
              selectedSessions={state().selectedSessions}
              isTokenMode={state().isTokenMode}
              onSelect={state().onSelectSession}
            />
          </div>
        )}
        {state().sessionsTab === "all" && props.overview ? (
          <div class="data-table-pagination">
            <div class="data-table-pagination__controls">
              <button
                class="btn btn--sm"
                disabled={props.loading || props.overview.offset === 0}
                onClick={() =>
                  props.usage.callbacks.display.onPageChange(
                    Math.max(0, props.overview!.offset - props.overview!.limit),
                  )
                }
              >
                {t("common.previous")}
              </button>
              <button
                class="btn btn--sm"
                disabled={
                  props.loading ||
                  props.overview.offset + props.overview.limit >= props.overview.total
                }
                onClick={() =>
                  props.usage.callbacks.display.onPageChange(
                    props.overview!.offset + props.overview!.limit,
                  )
                }
              >
                {t("common.next")}
              </button>
            </div>
          </div>
        ) : undefined}
        {state().selectedCount > 1 ? (
          <div class="sessions-selected-group">
            <div class="sessions-card-count">
              {t("usage.sessions.selected", { count: String(state().selectedCount) })}
            </div>
            <div class="session-bars session-bars--selected">
              <SessionRows
                entries={state().selectedEntries}
                selectedSessions={state().selectedSessions}
                isTokenMode={state().isTokenMode}
                onSelect={state().onSelectSession}
              />
            </div>
          </div>
        ) : undefined}
      </div>
    </SettingsSection>
  );
}

type SessionCardEntry = { session: UsageSessionEntry; displayLabel: string; value: number };

function SessionRows(props: {
  entries: SessionCardEntry[];
  selectedSessions: string[];
  isTokenMode: boolean;
  onSelect: UsageProps["callbacks"]["details"]["onSelectSession"];
}) {
  const orderedKeys = createMemo(() => props.entries.map((entry) => entry.session.key));
  return (
    <For each={props.entries} keyed={(entry) => entry.session.key}>
      {(entry) => (
        <SessionBarRow
          sessionKey={entry().session.key}
          displayLabel={entry().displayLabel}
          meta={buildSessionMeta(entry().session)}
          agentId={entry().session.agentId}
          valueLabel={
            props.isTokenMode ? formatUsageTokens(entry().value) : formatAnalysisCost(entry().value)
          }
          isSelected={props.selectedSessions.includes(entry().session.key)}
          onSelect={(event) => props.onSelect(entry().session.key, event.shiftKey, orderedKeys())}
        />
      )}
    </For>
  );
}
