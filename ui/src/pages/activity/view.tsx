import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { sortUniqueStrings } from "@openclaw/normalization-core/string-normalization";
import type { JSX } from "@solidjs/web";
import { For, createMemo } from "solid-js";
import { Icon } from "../../components/solid/icon.tsx";
import { SettingsToggle, SettingsStatus } from "../../components/solid/settings-ui.tsx";
import { syncPopoverExpanded, syncPopoverLabel } from "../../components/web-awesome-popover.ts";
import { registerActivityEnglish } from "../../i18n/locales/en-activity.ts";
import { formatDurationCompact } from "../../lib/format-duration.ts";
import { createMsFormatter } from "../../lib/format.ts";
import { getLocale, registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import "../../styles/activity.css";
import { activityRunInspectorHref } from "./run-inspector-model.ts";
import type { ActivityEntry, ActivityStatus } from "./tool-activity.ts";

registerEnglishCatalog(registerActivityEnglish);

const STATUS_ORDER: ActivityStatus[] = ["running", "done", "error"];

type ActivityProps = {
  basePath: string;
  entries: readonly ActivityEntry[];
  filterText: string;
  statusFilters: Record<ActivityStatus, boolean>;
  toolFilter: string;
  expandedIds: Set<string>;
  autoFollow: boolean;
  onFilterTextChange: (next: string) => void;
  onToolFilterChange: (next: string) => void;
  onStatusToggle: (status: ActivityStatus, enabled: boolean) => void;
  onToggleAutoFollow: (next: boolean) => void;
  onClear: () => void;
  onExpandAll: () => void;
  onCollapseAll: () => void;
  onEntryToggle: (id: string, open: boolean) => void;
  onScroll: JSX.EventHandler<HTMLDivElement, Event>;
};

function formatDuration(value: number): string {
  if (!Number.isFinite(value) || value < 0) {
    return t("common.na");
  }
  return formatDurationCompact(value) ?? "0ms";
}

function hiddenArgumentsLabel(count: number): string {
  if (count === 1) {
    return t("activity.argumentHiddenOne");
  }
  return t("activity.argumentsHidden", { count: String(count) });
}

function buildEntrySummary(entry: ActivityEntry): string {
  if (entry.entryKind === "answer_candidate") {
    return t(`activity.answerCandidate.${entry.candidateStatus ?? "candidate"}`);
  }
  return hiddenArgumentsLabel(entry.hiddenArgumentCount);
}

function entryLabel(entry: ActivityEntry): string {
  return entry.entryKind === "answer_candidate"
    ? t("activity.answerCandidate.title")
    : entry.toolName;
}

function matchesEntry(entry: ActivityEntry, needle: string): boolean {
  if (!needle) {
    return true;
  }
  const haystack = normalizeLowercaseStringOrEmpty(
    [
      entry.toolName,
      entryLabel(entry),
      entry.candidateStatus,
      entry.status,
      entry.summary,
      buildEntrySummary(entry),
      entry.outputPreview,
      entry.runId,
      entry.toolCallId,
      entry.sessionKey,
    ]
      .filter(Boolean)
      .join(" "),
  );
  return haystack.includes(needle);
}

function StatusFilter(props: { activity: ActivityProps; status: ActivityStatus }) {
  return (
    <label class="activity-status-filter">
      <input
        type="checkbox"
        checked={props.activity.statusFilters[props.status]}
        onChange={(event) =>
          props.activity.onStatusToggle(props.status, event.currentTarget.checked)
        }
      />
      <span>{t(`activity.status.${props.status}`)}</span>
    </label>
  );
}

function ToolFilter(props: { activity: ActivityProps; toolNames: string[] }) {
  return (
    <>
      <button
        id="activity-live-filter-trigger"
        type="button"
        class={[
          "btn btn--sm activity-live-filter-trigger",
          { active: Boolean(props.activity.toolFilter) },
        ]}
        title={t("activity.filters")}
        aria-label={t("activity.filters")}
        aria-haspopup="dialog"
        aria-expanded="false"
      >
        <Icon name="listFilter" />
      </button>
      <wa-popover
        ref={syncPopoverLabel}
        class="activity-live-filter-popover"
        for="activity-live-filter-trigger"
        aria-label={t("activity.filters")}
        placement="bottom-end"
        without-arrow
        onWa-show={syncPopoverExpanded}
        onWa-hide={syncPopoverExpanded}
      >
        <div class="activity-live-filter-popover__panel">
          <label class="field">
            <span>{t("activity.toolFilter")}</span>
            <select
              class="settings-select"
              aria-label={t("activity.toolFilter")}
              value={props.activity.toolFilter}
              onChange={(event) => props.activity.onToolFilterChange(event.currentTarget.value)}
            >
              <option value="" selected={props.activity.toolFilter === ""}>
                {t("activity.allTools")}
              </option>
              <For each={props.toolNames}>
                {(name) => (
                  <option value={name} selected={name === props.activity.toolFilter}>
                    {name}
                  </option>
                )}
              </For>
            </select>
          </label>
        </div>
      </wa-popover>
    </>
  );
}

function LiveToolbar(props: { activity: ActivityProps; toolNames: string[] }) {
  return (
    <div class="activity-live-toolbar">
      <div class="activity-feed__search activity-live-search">
        <span aria-hidden="true">
          <Icon name="search" />
        </span>
        <input
          class="settings-input"
          type="search"
          aria-label={t("activity.search")}
          value={props.activity.filterText}
          placeholder={t("activity.searchPlaceholder")}
          onInput={(event) => props.activity.onFilterTextChange(event.currentTarget.value)}
        />
      </div>
      <span role="group" aria-label={t("activity.statusFilters")} class="activity-status-filters">
        <For each={STATUS_ORDER}>
          {(status) => <StatusFilter activity={props.activity} status={status} />}
        </For>
      </span>
      <span class="activity-live-autofollow">
        <span>{t("activity.autoFollow")}</span>
        <SettingsToggle
          checked={props.activity.autoFollow}
          ariaLabel={t("activity.autoFollow")}
          onChange={(checked) => props.activity.onToggleAutoFollow(checked)}
        />
      </span>
      <ToolFilter activity={props.activity} toolNames={props.toolNames} />
    </div>
  );
}

const STATUS_KINDS = { running: "warn", done: "ok", error: "danger" } as const satisfies Record<
  ActivityStatus,
  "warn" | "ok" | "danger"
>;

function ActivityEntryView(props: {
  activity: ActivityProps;
  entry: ActivityEntry;
  formatTimestamp: ReturnType<typeof createMsFormatter>;
}) {
  return (
    <details
      class={`activity-entry activity-entry--${props.entry.status}`}
      prop:open={props.activity.expandedIds.has(props.entry.id)}
      onToggle={(event) => props.activity.onEntryToggle(props.entry.id, event.currentTarget.open)}
    >
      <summary class="activity-entry__summary">
        <span class="activity-entry__chevron" aria-hidden="true">
          <Icon name="chevronRight" />
        </span>
        <span class="activity-entry__main">
          <span class="activity-entry__title">
            <SettingsStatus
              kind={STATUS_KINDS[props.entry.status]}
              label={t(`activity.status.${props.entry.status}`)}
            />
            <span class="activity-entry__tool mono">{entryLabel(props.entry)}</span>
          </span>
          <span class="activity-entry__text">{buildEntrySummary(props.entry)}</span>
        </span>
        <span class="activity-entry__meta">
          <span>{props.formatTimestamp(props.entry.updatedAt)}</span>
          <span>{formatDuration(props.entry.durationMs)}</span>
        </span>
      </summary>
      <div class="activity-entry__body">
        <div class="activity-entry__facts">
          {props.entry.entryKind === "answer_candidate" ? (
            <span class="mono">
              {t("activity.answerCandidate.itemId")}: {props.entry.itemId}
            </span>
          ) : (
            <>
              <span>{hiddenArgumentsLabel(props.entry.hiddenArgumentCount)}</span>
              <span class="mono">
                {t("activity.toolCallId")}: {props.entry.toolCallId}
              </span>
            </>
          )}
          <a
            class="activity-entry__run-link mono"
            href={activityRunInspectorHref(props.entry.runId, props.activity.basePath)}
          >
            {t("activity.runId")}: {props.entry.runId}
          </a>
          {props.entry.sessionKey ? (
            <span class="mono">
              {t("activity.session")}: {props.entry.sessionKey}
            </span>
          ) : undefined}
        </div>
        {props.entry.outputPreview ? (
          <>
            <pre class="activity-entry__preview">{props.entry.outputPreview}</pre>
            {props.entry.outputTruncated ? (
              <div class="activity-entry__note">{t("activity.outputTruncated")}</div>
            ) : undefined}
          </>
        ) : (
          <div class="activity-entry__note">{t("activity.noOutputPreview")}</div>
        )}
      </div>
    </details>
  );
}

export function renderActivity(props: ActivityProps) {
  const formatTimestamp = createMemo(() => {
    // A locale change replaces the formatter while keeping stream rows mounted.
    getLocale();
    return createMsFormatter({ hour: "numeric", minute: "2-digit", second: "2-digit" }, "");
  });
  const toolNames = createMemo(
    () => sortUniqueStrings(props.entries.map((entry) => entry.toolName)),
    {
      equals: (a, b) => a.length === b.length && a.every((name, index) => name === b[index]),
    },
  );
  const filtered = createMemo(() => {
    const needle = normalizeLowercaseStringOrEmpty(props.filterText);
    return props.entries.filter(
      (entry) =>
        props.statusFilters[entry.status] &&
        (!props.toolFilter || entry.toolName === props.toolFilter) &&
        matchesEntry(entry, needle),
    );
  });

  // The stream fills the remaining viewport height; the settings-page column
  // wrapper is intentionally skipped so the fill-height flex chain
  // (.settings-workspace--fill-height … .activity-page … .activity-group …
  // .activity-stream) works. The named <section> keeps the region landmark.
  return (
    <section class="activity-page" aria-label={t("activity.title")}>
      <div class="settings-section__header">
        <h2 class="settings-section__heading">{t("activity.title")}</h2>
        <div class="settings-section__actions">
          <span class="activity-count" aria-live="polite">
            {t("activity.visibleCount", {
              visible: String(filtered().length),
              total: String(props.entries.length),
            })}
          </span>
          <button
            type="button"
            class="btn btn--sm"
            disabled={filtered().length === 0}
            onClick={() => props.onExpandAll()}
          >
            {t("activity.expandAll")}
          </button>
          <button
            type="button"
            class="btn btn--sm"
            disabled={props.expandedIds.size === 0}
            onClick={() => props.onCollapseAll()}
          >
            {t("activity.collapseAll")}
          </button>
          <button
            type="button"
            class="btn btn--sm danger"
            disabled={props.entries.length === 0}
            onClick={() => props.onClear()}
          >
            {t("activity.clear")}
          </button>
        </div>
      </div>
      <div class="settings-group activity-group">
        <LiveToolbar activity={props} toolNames={toolNames()} />
        <div
          class="activity-stream"
          role="group"
          aria-label={t("activity.streamLabel")}
          onScroll={(event) => props.onScroll(event)}
        >
          {filtered().length === 0 ? (
            <div class="activity-empty">
              {props.entries.length === 0 ? t("activity.empty") : t("activity.emptyFiltered")}
            </div>
          ) : (
            <For each={filtered()} keyed={(entry) => entry.id}>
              {(entry) => (
                <ActivityEntryView
                  activity={props}
                  entry={entry()}
                  formatTimestamp={formatTimestamp()}
                />
              )}
            </For>
          )}
        </div>
      </div>
    </section>
  );
}
