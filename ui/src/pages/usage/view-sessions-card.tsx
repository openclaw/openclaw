import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { For, Show, createMemo, createSignal } from "solid-js";
import { AgentRowChip } from "../../components/agent-row-chip.tsx";
import { handleCopyButton } from "../../components/copy-button-state.ts";
import { providerDisplayLabel } from "../../components/provider-icon-data.ts";
import { Icon } from "../../components/solid/icon.tsx";
import { SettingsSelect } from "../../components/solid/settings-select.tsx";
import { SettingsSection, SettingsSegmented } from "../../components/solid/settings-ui.tsx";
import { formatDurationCompact } from "../../lib/format-duration.ts";
import { i18nRevision, t } from "../../lib/reactive/i18n.ts";
import "../../components/tooltip.ts";
import { formatAnalysisCost, formatUsageTokens } from "./metrics.ts";
import type { UsageProps, UsageSessionEntry } from "./types.ts";

const SESSION_SORT_OPTIONS = [
  { value: "cost", labelKey: "usage.metrics.cost" },
  { value: "errors", labelKey: "usage.overview.errors" },
  { value: "messages", labelKey: "usage.overview.messages" },
  { value: "recent", labelKey: "usage.sessions.recentShort" },
  { value: "tokens", labelKey: "usage.metrics.tokens" },
] as const;

/** Plain facts for a session row: where it ran, on what, and how much happened. */
const buildSessionMeta = (session: UsageSessionEntry): string[] => {
  const provider = session.modelProvider ?? session.providerOverride;
  const counts = session.usage?.messageCounts;
  const tools = session.usage?.toolUsage?.totalCalls;
  return [
    session.channel,
    provider && providerDisplayLabel(provider),
    session.model,
    counts && `${counts.total.toLocaleString()} ${t("usage.overview.messagesAbbrev")}`,
    tools && `${tools.toLocaleString()} ${t("usage.overview.calls")}`,
    counts?.errors &&
      `${counts.errors.toLocaleString()} ${normalizeLowercaseStringOrEmpty(t("usage.overview.errors"))}`,
    session.usage?.durationMs && formatDurationCompact(session.usage.durationMs),
  ].filter((part): part is string => typeof part === "string" && part.length > 0);
};

const SESSION_PREVIEW = 10;

export function SessionsCard(props: {
  sessions: UsageSessionEntry[];
  usage: UsageProps;
  overview?: UsageProps["data"]["sessionPage"];
  loading?: boolean;
  totalSessions: number;
}) {
  const isTokenMode = createMemo(() => props.usage.display.chartMode === "tokens");
  // The page leads with the costliest sessions; the rest of the page stays one click away.
  const [showAll, setShowAll] = createSignal(false);
  const selectedRows = () => props.usage.data.overview?.selectedRows ?? [];
  const averageLabel = createMemo(() => {
    i18nRevision();
    const count = props.overview?.tableSessionCount ?? 0;
    const totals = props.overview?.tableTotals;
    const value = (isTokenMode() ? totals?.tokens : totals?.cost) ?? 0;
    const average = count ? value / count : 0;
    return isTokenMode() ? formatUsageTokens(average) : formatAnalysisCost(average);
  });
  const sortDirectionLabel = () =>
    t(
      props.usage.display.sessionSortDir === "desc"
        ? "usage.sessions.descending"
        : "usage.sessions.ascending",
    );
  return (
    <SettingsSection title={t("usage.sessions.title")}>
      <div class="usage-panel sessions-card">
        <div class="sessions-card-header">
          <div class="sessions-card-count">
            {t("usage.sessions.shown", { count: String(props.sessions.length) })}
            {props.totalSessions !== props.sessions.length
              ? ` · ${t("usage.sessions.total", { count: props.totalSessions.toLocaleString() })}`
              : ""}
          </div>
        </div>
        <div class="sessions-card-meta">
          <div class="sessions-card-stats">
            <span>
              {averageLabel()} {t("usage.sessions.avg")}
            </span>
            <span>
              {(props.overview?.tableTotals.errors ?? 0).toLocaleString()}{" "}
              {normalizeLowercaseStringOrEmpty(t("usage.overview.errors"))}
            </span>
          </div>
          <SettingsSegmented
            mode="buttons"
            variant="accent"
            class="small"
            value={props.usage.display.sessionsTab}
            onChange={(tab) => props.usage.callbacks.display.onChange({ sessionsTab: tab })}
            onReselect={(tab) => props.usage.callbacks.display.onChange({ sessionsTab: tab })}
            options={[
              { value: "all", label: t("usage.sessions.all") },
              { value: "recent", label: t("usage.sessions.recent") },
            ]}
          />
          <label class="sessions-sort">
            <span>{t("usage.sessions.sort")}</span>
            <SettingsSelect
              value={props.usage.display.sessionSort}
              options={SESSION_SORT_OPTIONS.map(({ value, labelKey }) => ({
                value,
                label: t(labelKey),
              }))}
              onChange={(event) => {
                const selected = SESSION_SORT_OPTIONS.find(
                  (option) => option.value === event.currentTarget.value,
                );
                if (selected) {
                  props.usage.callbacks.display.onChange({ sessionSort: selected.value });
                }
              }}
            />
          </label>
          <openclaw-tooltip prop:content={sortDirectionLabel()}>
            <button
              class="btn btn--sm"
              aria-label={sortDirectionLabel()}
              onClick={() =>
                props.usage.callbacks.display.onChange({
                  sessionSortDir: props.usage.display.sessionSortDir === "desc" ? "asc" : "desc",
                })
              }
            >
              {props.usage.display.sessionSortDir === "desc" ? "↓" : "↑"}
            </button>
          </openclaw-tooltip>
          {props.usage.filters.selectedSessions.length > 0 ? (
            <button
              class="btn btn--sm"
              onClick={() => props.usage.callbacks.filters.onClearSessions()}
            >
              {t("usage.sessions.clearSelection")}
            </button>
          ) : undefined}
        </div>
        {props.sessions.length === 0 ? (
          <div class="usage-empty-block">
            {t(
              props.usage.display.sessionsTab === "recent"
                ? "usage.sessions.noRecent"
                : "usage.sessions.noneInRange",
            )}
          </div>
        ) : (
          <div
            class={[
              "session-bars",
              { "session-bars--recent": props.usage.display.sessionsTab === "recent" },
            ]}
          >
            <SessionRows
              sessions={showAll() ? props.sessions : props.sessions.slice(0, SESSION_PREVIEW)}
              selectedSessions={props.usage.filters.selectedSessions}
              isTokenMode={isTokenMode()}
              onSelect={props.usage.callbacks.details.onSelectSession}
            />
            <Show when={props.sessions.length > SESSION_PREVIEW}>
              <button
                type="button"
                class="btn btn--sm btn--ghost sessions-show-all"
                aria-expanded={showAll() ? "true" : "false"}
                onClick={() => setShowAll((current) => !current)}
              >
                {showAll()
                  ? t("usage.sessions.showTop", { count: String(SESSION_PREVIEW) })
                  : t("usage.sessions.showAll", { count: props.sessions.length.toLocaleString() })}
              </button>
            </Show>
          </div>
        )}
        <Show when={props.usage.display.sessionsTab === "all" ? props.overview : undefined}>
          {(overview) => (
            <div class="data-table-pagination">
              <div class="data-table-pagination__controls">
                <button
                  class="btn btn--sm"
                  disabled={props.loading || overview().offset === 0}
                  onClick={() =>
                    props.usage.callbacks.display.onPageChange(
                      Math.max(0, overview().offset - overview().limit),
                    )
                  }
                >
                  {t("common.previous")}
                </button>
                <button
                  class="btn btn--sm"
                  disabled={
                    props.loading || overview().offset + overview().limit >= overview().total
                  }
                  onClick={() =>
                    props.usage.callbacks.display.onPageChange(overview().offset + overview().limit)
                  }
                >
                  {t("common.next")}
                </button>
              </div>
            </div>
          )}
        </Show>
        {selectedRows().length > 1 ? (
          <div class="sessions-selected-group">
            <div class="sessions-card-count">
              {t("usage.sessions.selected", { count: String(selectedRows().length) })}
            </div>
            <div class="session-bars session-bars--selected">
              <SessionRows
                sessions={selectedRows()}
                selectedSessions={props.usage.filters.selectedSessions}
                isTokenMode={isTokenMode()}
                onSelect={props.usage.callbacks.details.onSelectSession}
              />
            </div>
          </div>
        ) : undefined}
      </div>
    </SettingsSection>
  );
}

function SessionRows(props: {
  sessions: UsageSessionEntry[];
  selectedSessions: string[];
  isTokenMode: boolean;
  onSelect: UsageProps["callbacks"]["details"]["onSelectSession"];
}) {
  const orderedKeys = createMemo(() => props.sessions.map((session) => session.key));
  return (
    <For each={props.sessions} keyed={(session) => session.key}>
      {(session) => {
        const label = () => {
          const raw = session().label || session().key;
          // Agent session keys often include a token query param; remove it for readability.
          return raw.startsWith("agent:") && raw.includes("?token=")
            ? raw.slice(0, raw.indexOf("?token="))
            : raw;
        };
        const meta = createMemo(() => {
          i18nRevision();
          return buildSessionMeta(session());
        });
        const valueLabel = createMemo(() => {
          i18nRevision();
          const usage = session().usage;
          return props.isTokenMode
            ? formatUsageTokens(usage?.totalTokens ?? 0)
            : formatAnalysisCost(usage?.totalCost ?? 0);
        });
        const copyIdentity = createMemo(() => ({ label: label() }), {
          equals: (previous, next) => previous.label === next.label,
        });
        const onSelect = (event: MouseEvent) =>
          props.onSelect(session().key, event.shiftKey, orderedKeys());
        return (
          <div
            class={[
              "session-bar-row",
              { selected: props.selectedSessions.includes(session().key) },
            ]}
            onClick={(event: MouseEvent) => {
              if (event.target instanceof Element && event.target.closest("button")) {
                return;
              }
              onSelect(event);
            }}
            title={session().key}
          >
            <button
              type="button"
              class="session-bar-selection"
              aria-label={label()}
              aria-pressed={props.selectedSessions.includes(session().key) ? "true" : "false"}
              onClick={(event) => onSelect(event)}
            >
              <span class="session-bar-label">
                <span class="session-bar-title">{label()}</span>
                {session().agentId ? <AgentRowChip agentId={session().agentId} /> : undefined}
                {meta().length > 0 ? (
                  <>
                    {" "}
                    <span class="session-bar-meta">{meta().join(" · ")}</span>{" "}
                  </>
                ) : undefined}
              </span>
            </button>
            <div class="session-bar-actions">
              <Show when={copyIdentity()} keyed>
                {(_identity) => {
                  let feedback!: HTMLSpanElement;
                  let announcement!: HTMLSpanElement;
                  return (
                    <>
                      {" "}
                      <button
                        type="button"
                        class="btn btn--sm btn--icon session-bar-copy"
                        aria-label={t("usage.sessions.copy")}
                        title={t("usage.sessions.copy")}
                        onClick={(event: MouseEvent) => {
                          event.stopPropagation();
                          void handleCopyButton(event, label(), t("usage.sessions.copy"), {
                            feedback,
                            announcement,
                          });
                        }}
                      >
                        <Icon name="copy" />
                      </button>
                      <span
                        ref={(element) => (feedback = element)}
                        class="session-bar-copy-feedback"
                        hidden
                      />
                      <span
                        ref={(element) => (announcement = element)}
                        class="sr-only"
                        role="status"
                      />{" "}
                    </>
                  );
                }}
              </Show>
              <div class="session-bar-value">{valueLabel()}</div>
            </div>
          </div>
        );
      }}
    </For>
  );
}
