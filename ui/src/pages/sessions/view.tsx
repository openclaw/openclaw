import { parseStrictPositiveInteger } from "@openclaw/normalization-core/number-coercion";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { createMemo, For } from "solid-js";
import type { GatewaySessionRow } from "../../api/types.ts";
import { Icon } from "../../components/solid/icon.tsx";
import {
  SettingsPage,
  SettingsSection,
  SettingsSegmented,
} from "../../components/solid/settings-ui.tsx";
import { presenceViewerLabel } from "../../lib/presence-users.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { resolveSessionDisplayKind } from "../../lib/session-display.ts";
import { isSessionRunActive } from "../../lib/session-run-state.ts";
import {
  groupSessionRows,
  type SessionRowGroup,
  UNGROUPED_ID,
} from "../../lib/sessions/grouping.ts";
import type { SessionArchivedFilter } from "../../lib/sessions/index.ts";
import { getAgentIdentity, SessionRows, sessionsTableColumnCount } from "./session-row.tsx";
import {
  categoryDropHandlers,
  clearSessionsSearch,
  handleSessionsSearchKeydown,
  SessionsAdvancedFilters,
} from "./sessions-filters.tsx";
import { TranscriptSearch } from "./transcript-search-view.tsx";
import type { SessionsProps } from "./view-types.ts";
import "../../styles/sessions.css";

const PAGE_SIZES = [10, 25, 50, 100] as const;

function renderSessionsHeadingFacts(
  rows: GatewaySessionRow[],
  liveCount: number,
  statusFilter: SessionArchivedFilter,
) {
  const unreadCount = rows.filter((row) => row.unread === true && row.archived !== true).length;
  const archivedCount = rows.filter((row) => row.archived === true).length;
  const facts: Array<readonly [string, string, boolean]> = [
    [String(liveCount), t("sessionsView.statusLive"), liveCount > 0],
    [String(unreadCount), t("sessionsView.unread"), unreadCount > 0],
  ];
  if (statusFilter !== "active") {
    facts.push([String(archivedCount), t("sessionsView.archived"), false]);
  }
  return (
    <span class="sessions-heading-facts">
      <For each={facts}>
        {([value, label, active], index) => (
          <>
            {index() > 0 ? (
              <span class="sessions-heading-fact__separator" aria-hidden="true">
                ·
              </span>
            ) : undefined}
            <span
              class={
                active
                  ? "sessions-heading-fact sessions-heading-fact--active"
                  : "sessions-heading-fact"
              }
            >
              <strong>{value}</strong> {label}
            </span>
          </>
        )}
      </For>
    </span>
  );
}

const SKELETON_ROW_COUNT = 4;

// Initial load renders shimmer rows instead of flashing the empty state
// before the first sessions.list result arrives.
function renderSkeletonRows(columnCount: number) {
  return Array.from({ length: SKELETON_ROW_COUNT }, (_, rowIndex) => (
    <tr class="session-skeleton-row" aria-hidden="true">
      {Array.from({ length: columnCount }, (_cell, columnIndex) =>
        columnIndex === 0 ? (
          <td class="data-table-checkbox-col" />
        ) : (
          <td>
            <span
              class={["session-skeleton", { "session-skeleton--key": columnIndex === 1 }]}
              style={{ "animation-delay": `${rowIndex * 120}ms` }}
            />
          </td>
        ),
      )}
    </tr>
  ));
}

function sessionGroupLabel(group: SessionRowGroup, props: SessionsProps): string {
  const { id } = group;
  if (props.groupBy === "date") {
    const labels: Record<string, string> = {
      today: "sessionsView.dateToday",
      yesterday: "sessionsView.dateYesterday",
      week: "sessionsView.dateThisWeek",
      older: "sessionsView.dateOlder",
    };
    return t(labels[id] ?? "sessionsView.dateNoActivity");
  }
  if (id === UNGROUPED_ID) {
    return t("sessionsView.ungrouped");
  }
  if (props.groupBy === "agent") {
    const identity = getAgentIdentity(props.agentIdentityById, id);
    const name = normalizeOptionalString(identity?.name);
    if (name) {
      const emoji = normalizeOptionalString(identity?.emoji);
      return emoji ? `${emoji} ${name}` : name;
    }
  }
  if (props.groupBy === "person") {
    const actor = group.rows[0]?.owner?.actor;
    return actor?.identity?.type === "profile"
      ? presenceViewerLabel({ id: actor.identity.id, name: actor.label?.trim() || id })
      : actor?.label?.trim() || id;
  }
  return id;
}

function renderGroupHeaderRow(group: SessionRowGroup, props: SessionsProps) {
  const label = sessionGroupLabel(group, props);
  const count = t(
    group.rows.length === 1 ? "sessionsView.groupRowCountOne" : "sessionsView.groupRowCount",
    { count: String(group.rows.length) },
  );
  const drop = categoryDropHandlers(props, group.id === UNGROUPED_ID ? null : group.id);
  return (
    <tr
      class="session-group-row"
      onDragOver={drop.dragover}
      onDragLeave={drop.dragleave}
      onDrop={drop.drop}
    >
      <td colspan={sessionsTableColumnCount(props)}>
        <div class="session-group-row__header">
          <span class="session-group-row__icon" aria-hidden="true">
            <Icon name="folder" />
          </span>
          <span class="session-group-row__label">{label}</span>
          <span class="session-group-row__count">{count}</span>
        </div>
      </td>
    </tr>
  );
}

export function SessionsView(props: SessionsProps) {
  const rows = createMemo(() => props.result?.sessions ?? []);
  const liveCount = createMemo(() => rows().filter(isSessionRunActive).length);
  const archivedCount = createMemo(() => rows().filter((row) => row.archived === true).length);
  return (
    <SettingsPage wide>
      {props.error ? (
        <div class="sessions-error" role="alert">
          {props.error}
        </div>
      ) : undefined}
      <SettingsSection title={t("sessionsView.transcriptSearchTitle")}>
        <TranscriptSearch {...props} />
      </SettingsSection>
      <SettingsSection
        title={
          <>
            {t("sessionsView.title")}
            {props.result ? (
              <openclaw-tooltip prop:content={t("sessionsView.store", { path: props.result.path })}>
                <span class="settings-count">{rows().length}</span>
              </openclaw-tooltip>
            ) : undefined}
            {props.result
              ? renderSessionsHeadingFacts(rows(), liveCount(), props.statusFilter)
              : undefined}
          </>
        }
        actions={
          <>
            {props.statusFilter === "archived" ? (
              <button
                class="btn danger"
                disabled={
                  props.loading ||
                  archivedCount() === 0 ||
                  Boolean(props.deleteArchivedDisabledReason)
                }
                title={props.deleteArchivedDisabledReason}
                onClick={props.onDeleteAllArchived}
              >
                <Icon name="trash" /> {t("sessionsView.deleteAllArchived")}
              </button>
            ) : undefined}
            <button class="btn" disabled={props.refreshing} onClick={() => props.onRefresh()}>
              {props.refreshing ? t("common.loading") : t("common.refresh")}
            </button>
          </>
        }
      >
        <SessionsTable {...props} />
      </SettingsSection>
    </SettingsPage>
  );
}

function SortHeader(
  props: Pick<SessionsProps, "sortColumn" | "sortDir" | "onSortChange"> & {
    column: SessionsProps["sortColumn"];
    label: string;
    extraClass?: string;
  },
) {
  const active = createMemo(() => props.sortColumn === props.column);
  return (
    <th
      class={props.extraClass ?? ""}
      data-sortable
      data-sort-dir={active() ? props.sortDir : ""}
      aria-sort={active() ? (props.sortDir === "asc" ? "ascending" : "descending") : undefined}
      onClick={() => {
        const nextDir = !active() || props.sortDir === "asc" ? "desc" : "asc";
        props.onSortChange(props.column, nextDir);
      }}
    >
      <button class="data-table-sort-button" type="button">
        {props.label}
        <span class="data-table-sort-icon" aria-hidden="true">
          <Icon name="arrowUpDown" />
        </span>
      </button>
    </th>
  );
}

function SessionsTable(props: SessionsProps) {
  const rawRows = createMemo(() => props.result?.sessions ?? []);
  const searchQuery = createMemo(() => props.searchQuery);
  const pageSizeValue = createMemo(() => String(props.pageSize));
  const direction = createMemo(() => (props.sortDir === "asc" ? 1 : -1));
  const sorted = createMemo(() => {
    const column = props.sortColumn;
    const sortDirection = direction();
    return rawRows().toSorted((a, b) => {
      const pinnedDiff = (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0);
      if (pinnedDiff !== 0) {
        return pinnedDiff;
      }
      const diff =
        column === "kind"
          ? resolveSessionDisplayKind(a).localeCompare(resolveSessionDisplayKind(b))
          : column === "key"
            ? a.key.localeCompare(b.key)
            : column === "updated"
              ? (a.updatedAt ?? 0) - (b.updatedAt ?? 0)
              : (a.totalTokens ?? a.inputTokens ?? a.outputTokens ?? 0) -
                (b.totalTokens ?? b.inputTokens ?? b.outputTokens ?? 0);
      return diff * sortDirection;
    });
  });
  const totalRows = createMemo(() => sorted().length);
  const totalPages = createMemo(() => Math.max(1, Math.ceil(totalRows() / props.pageSize)));
  const page = createMemo(() => Math.min(props.page, totalPages() - 1));
  const groups = createMemo(() =>
    props.groupBy !== "none"
      ? groupSessionRows({
          rows: sorted(),
          mode: props.groupBy,
          knownCategories: props.knownCategories,
        })
      : null,
  );
  const displayRows = createMemo(() => groups()?.flatMap((group) => group.rows) ?? sorted());
  const paginated = createMemo(() =>
    displayRows().slice(page() * props.pageSize, (page() + 1) * props.pageSize),
  );
  const emptyBecauseFiltered = createMemo(
    () =>
      rawRows().length === 0 &&
      (normalizeLowercaseStringOrEmpty(props.searchQuery).length > 0 ||
        parseStrictPositiveInteger(props.activeMinutes) !== undefined ||
        !props.includeGlobal),
  );
  const emptyStateMessage = createMemo(() =>
    t(
      emptyBecauseFiltered()
        ? "sessionsView.noSessionsMatchFilters"
        : props.statusFilter === "archived"
          ? "sessionsView.noArchivedSessions"
          : props.statusFilter === "active"
            ? "sessionsView.noActiveSessions"
            : "sessionsView.noSessions",
    ),
  );

  const paginatedKeys = createMemo(() =>
    groups() ? new Set(paginated().map((row) => row.key)) : null,
  );
  return (
    <>
      <div
        class="sessions-toolbar sessions-filter-bar"
        role="group"
        aria-label={t("sessionsView.filterControls")}
      >
        <div class="data-table-search sessions-toolbar__search">
          <Icon name="search" />
          <input
            type="text"
            aria-label={t("sessionsView.searchPlaceholder")}
            placeholder={t("sessionsView.searchPlaceholder")}
            value={searchQuery()}
            onInput={(e) => props.onSearchChange(e.currentTarget.value)}
            onKeyDown={(event: KeyboardEvent) => handleSessionsSearchKeydown(event, props)}
          />
          <button
            type="button"
            class="sessions-toolbar__clear"
            aria-label={t("sessionsView.clearSearch")}
            title={t("sessionsView.clearSearch")}
            hidden={!props.searchQuery}
            disabled={!props.searchQuery}
            onClick={(event: MouseEvent) => clearSessionsSearch(event, props.onSearchChange)}
          >
            <Icon name="x" />
          </button>
        </div>
        <SettingsSegmented<SessionArchivedFilter>
          value={props.statusFilter}
          ariaLabel={t("sessionsView.sessionState")}
          class="sessions-view-segment"
          options={[
            { value: "active", label: t("common.active") },
            {
              value: "archived",
              label: t("sessionsView.archived"),
              title: t("sessionsView.archivedOnlyTooltip"),
            },
            { value: "all", label: t("sessionsView.all") },
          ]}
          onChange={(value) => props.onStatusFilterChange(value)}
        />
        <SessionsAdvancedFilters {...props} />
      </div>

      {props.selectedKeys.size > 0 ? (
        <div class="data-table-bulk-bar">
          <span>{t("sessionsView.selected", { count: String(props.selectedKeys.size) })}</span>
          <button class="btn btn--sm" onClick={props.onDeselectAll}>
            {t("common.unselect")}
          </button>
          <button
            class="btn btn--sm danger"
            disabled={props.loading || Boolean(props.deleteSelectedDisabledReason)}
            title={props.deleteSelectedDisabledReason ?? undefined}
            onClick={props.onDeleteSelected}
          >
            <Icon name="trash" /> {t("sessionsView.deleteSelected")}
          </button>
        </div>
      ) : undefined}

      <div class="data-table-container">
        <table class="data-table sessions-table">
          <thead>
            <tr>
              <th class="data-table-checkbox-col">
                {paginated().length > 0 ? (
                  <input
                    type="checkbox"
                    checked={paginated().every((r) => props.selectedKeys.has(r.key))}
                    prop:indeterminate={
                      paginated().some((r) => props.selectedKeys.has(r.key)) &&
                      !paginated().every((r) => props.selectedKeys.has(r.key))
                    }
                    onChange={() => {
                      const update = paginated().every((r) => props.selectedKeys.has(r.key))
                        ? props.onDeselectPage
                        : props.onSelectPage;
                      update(paginated().map((r) => r.key));
                    }}
                    aria-label={t("sessionsView.selectAllOnPage")}
                  />
                ) : undefined}
              </th>
              <SortHeader
                {...props}
                column="key"
                label={t("sessionsView.key")}
                extraClass="data-table-key-col"
              />
              {props.groupBy === "category" ? <th>{t("sessionsView.group")}</th> : undefined}
              <SortHeader {...props} column="kind" label={t("sessionsView.kind")} />
              <th class="session-status-col">{t("sessionsView.status")}</th>
              <SortHeader {...props} column="updated" label={t("sessionsView.updated")} />
              <SortHeader {...props} column="tokens" label={t("sessionsView.tokens")} />
              <th class="session-actions-col">
                <span class="sr-only">{t("sessionsView.actions")}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {props.loading && !props.result ? (
              renderSkeletonRows(sessionsTableColumnCount(props))
            ) : paginated().length === 0 &&
              (props.loading || props.error || !props.result) ? undefined : paginated().length ===
              0 ? (
              <tr>
                <td colspan={sessionsTableColumnCount(props)} class="data-table-empty-cell">
                  <div class="data-table-empty-state" role="status" aria-live="polite">
                    <div class="data-table-empty-state__message">
                      <Icon name={emptyBecauseFiltered() ? "search" : "messageSquare"} />
                      <span>{emptyStateMessage()}</span>
                    </div>
                    {emptyBecauseFiltered() ? (
                      <button class="btn btn--sm" onClick={props.onClearFilters}>
                        {t("sessionsView.showAll")}
                      </button>
                    ) : undefined}
                  </div>
                </td>
              </tr>
            ) : groups() ? (
              <For each={groups()} keyed={(group) => group.id}>
                {(group) => (
                  <SessionGroup {...props} group={group()} paginatedKeys={paginatedKeys()} />
                )}
              </For>
            ) : (
              <For each={paginated()} keyed={(row) => row.key}>
                {(row) => <SessionRows {...props} row={row()} />}
              </For>
            )}
          </tbody>
        </table>
      </div>

      {totalRows() > 0 ? (
        <div class="data-table-pagination">
          <div class="data-table-pagination__info">
            {t("sessionsView.pagination", {
              start: String(page() * props.pageSize + 1),
              end: String(Math.min((page() + 1) * props.pageSize, totalRows())),
              total: String(totalRows()),
            })}
          </div>
          <div class="data-table-pagination__controls">
            <select
              class="data-table-pagination__size"
              aria-label={t("sessionsView.pageSize")}
              value={pageSizeValue()}
              onChange={(e) => props.onPageSizeChange(Number(e.currentTarget.value))}
            >
              <For each={PAGE_SIZES}>
                {(s) => (
                  <option value={s} selected={s === props.pageSize}>
                    {t("sessionsView.rowsPerPage", { count: String(s) })}
                  </option>
                )}
              </For>
            </select>
            {props.result?.hasMore && props.result.nextOffset != null ? (
              <button disabled={props.loading} onClick={props.onLoadMore}>
                {t("chat.selectors.loadMoreRosterSessions")}
              </button>
            ) : undefined}
            <button disabled={page() <= 0} onClick={() => props.onPageChange(page() - 1)}>
              {t("common.previous")}
            </button>
            <button
              disabled={page() >= totalPages() - 1}
              onClick={() => props.onPageChange(page() + 1)}
            >
              {t("common.next")}
            </button>
          </div>
        </div>
      ) : undefined}
    </>
  );
}

function SessionGroup(
  props: SessionsProps & { group: SessionRowGroup; paginatedKeys: Set<string> | null },
) {
  const visibleRows = createMemo(() =>
    props.group.rows.filter((row) => props.paginatedKeys?.has(row.key)),
  );
  return (
    <>
      {visibleRows().length > 0 || props.group.rows.length === 0 ? (
        <>
          {renderGroupHeaderRow(props.group, props)}
          <For each={visibleRows()} keyed={(row) => row.key}>
            {(row) => <SessionRows {...props} row={row()} />}
          </For>
        </>
      ) : undefined}
    </>
  );
}
