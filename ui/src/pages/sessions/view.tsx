import { parseStrictPositiveInteger } from "@openclaw/normalization-core/number-coercion";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { createDeferred, createMemo, Errored, isPending, Loading, Repeat, Show } from "solid-js";
import { Icon } from "../../components/solid/icon.tsx";
import { ContextNewSessionAction } from "../../components/solid/new-session-link.tsx";
import { SettingsSelect } from "../../components/solid/settings-select.tsx";
import {
  SettingsPage,
  SettingsSection,
  SettingsStatus,
} from "../../components/solid/settings-ui.tsx";
import { registerSessionMenuEnglish } from "../../i18n/locales/en-session-menu.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { useOptionalApplication } from "../../lib/reactive/context.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { groupSessionRows } from "../../lib/sessions/grouping.ts";
import { sessionsTableColumnCount } from "./session-row.tsx";
import { SessionWindow, type SessionEntry } from "./session-window.tsx";
import { SessionsAdvancedFilters } from "./sessions-filters.tsx";
import { TranscriptSearchForm, TranscriptSearchResults } from "./transcript-search-view.tsx";
import type { SessionsProps } from "./view-types.ts";
import "../../styles/sessions.css";

registerSessionMenuEnglish();

const PAGE_SIZES = [10, 25, 50, 100] as const;

const SKELETON_ROW_COUNT = 4;
type RosterOutcome = { ok: true } | { ok: false; error: unknown };

// Initial load renders shimmer rows instead of flashing the empty state
// before the first sessions.list result arrives.
function SkeletonRows(props: { columnCount: number }) {
  return (
    <Repeat count={SKELETON_ROW_COUNT}>
      {(rowIndex) => (
        <tr class="session-skeleton-row" aria-hidden="true">
          <Repeat count={props.columnCount}>
            {(columnIndex) =>
              columnIndex === 0 ? (
                <td class="data-table-checkbox-col" />
              ) : (
                <td>
                  <span
                    class={["session-skeleton", { "session-skeleton--key": columnIndex === 1 }]}
                    style={{ "animation-delay": `${rowIndex * 120}ms` }}
                  />
                </td>
              )
            }
          </Repeat>
        </tr>
      )}
    </Repeat>
  );
}

export function SessionsView(props: SessionsProps) {
  const application = useOptionalApplication();
  const rows = createMemo(() => props.result?.sessions ?? []);
  const archivedCount = createMemo(() => rows().filter((row) => row.archived === true).length);
  const transcriptSearch = createMemo(() => props.transcriptSearch);
  const receipt = createMemo(() => ({ promise: props.roster }), {
    equals: (previous, next) => previous.promise === next.promise,
  });
  // Readiness may lag during revalidation; owner rows and controls must keep publishing.
  const roster = createDeferred<RosterOutcome>(() => {
    const promise = receipt().promise;
    return promise
      ? promise.then<RosterOutcome, RosterOutcome>(
          () => ({ ok: true }),
          (error: unknown) => ({ ok: false, error }),
        )
      : { ok: true };
  });
  const commandError = createMemo(() => {
    if (props.error) {
      // oxlint-disable-next-line typescript/only-throw-error -- Relay the owner's original error; the boundary formats it for display.
      throw props.error;
    }
    return null;
  });
  return (
    <SettingsPage wide>
      <Show when={!props.commandPending}>
        <Errored
          fallback={(error) => (
            <div class="sessions-error" role="alert">
              {formatUiError(error())}
            </div>
          )}
        >
          {commandError()}
        </Errored>
      </Show>
      <Errored
        fallback={(error) => (
          <div class="sessions-error" role="alert">
            {formatUiError(error())}
          </div>
        )}
      >
        <Loading fallback={null}>
          <SessionsRosterStatus readRoster={roster} />
        </Loading>
      </Errored>
      <SettingsSection
        title={t("sessionsView.title")}
        description={
          !props.transcriptSearchAvailable ? (
            <span role="status">{t("sessionsView.transcriptSearchUnavailable")}</span>
          ) : undefined
        }
        actions={
          <>
            <Show when={props.commandPending}>
              <span role="status">
                <SettingsStatus kind="muted" label={t("common.working")} />
              </span>
            </Show>
            <TranscriptSearchForm {...props} />
            <button
              class="btn btn--xs btn--icon sessions-toolbar__icon sessions-toolbar__refresh"
              type="button"
              aria-label={t("common.refresh")}
              disabled={props.refreshing || props.refreshDisabled}
              onClick={() => props.onRefresh()}
            >
              <Icon name="refresh" />
            </button>
            <SessionsAdvancedFilters
              {...props}
              searchQuery={props.searchQuery}
              archivedCount={archivedCount()}
            />
            <Show when={application}>
              {(context) => (
                <ContextNewSessionAction
                  context={context()}
                  class="btn btn--xs btn--icon primary sessions-toolbar__icon sessions-toolbar__new-session"
                  agentId={props.agentId}
                  label={t("newSession.title")}
                  showTooltip={false}
                />
              )}
            </Show>
          </>
        }
      >
        <Show when={props.transcriptSearch !== null}>
          <TranscriptSearchResults {...props} readSearch={transcriptSearch} />
        </Show>
        <SessionsTable {...props} readRoster={roster} />
      </SettingsSection>
    </SettingsPage>
  );
}

function SessionsRosterStatus(props: { readRoster: () => RosterOutcome }) {
  const error = createMemo(() => {
    const outcome = props.readRoster();
    if (!outcome.ok) {
      throw outcome.error;
    }
    return null;
  });
  return <>{error()}</>;
}

function SortHeader(
  props: Pick<SessionsProps, "sortColumn" | "sortDir" | "onSortChange"> & {
    column: SessionsProps["sortColumn"];
    label: string;
    extraClass?: string;
  },
) {
  const active = () => props.sortColumn === props.column;
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

function SessionsTable(props: SessionsProps & { readRoster: () => RosterOutcome }) {
  const rawRows = createMemo(() => props.result?.sessions ?? []);
  const pageSize = createMemo(() => props.pageSize);
  const groupBy = createMemo(() => props.groupBy);
  const knownCategories = createMemo(() => props.knownCategories);
  const pageSizeValue = createMemo(() => String(props.pageSize));
  const sortColumn = createMemo(() => props.sortColumn);
  const direction = createMemo(() => (props.sortDir === "asc" ? 1 : -1));
  const sorted = createMemo(() => {
    const column = sortColumn();
    const sortDirection = direction();
    return rawRows().toSorted((a, b) => {
      const pinnedDiff = (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0);
      if (pinnedDiff !== 0) {
        return pinnedDiff;
      }
      const diff =
        column === "key" ? a.key.localeCompare(b.key) : (a.updatedAt ?? 0) - (b.updatedAt ?? 0);
      return diff * sortDirection;
    });
  });
  const totalRows = () => sorted().length;
  const totalPages = createMemo(() => Math.max(1, Math.ceil(totalRows() / props.pageSize)));
  const page = createMemo(() => Math.min(props.page, totalPages() - 1));
  const groups = createMemo(() => {
    const mode = groupBy();
    return mode !== "none"
      ? groupSessionRows({ rows: sorted(), mode, knownCategories: knownCategories() })
      : null;
  });
  const displayRows = createMemo(() => groups()?.flatMap((group) => group.rows) ?? sorted());
  const paginated = createMemo(() =>
    displayRows().slice(page() * pageSize(), (page() + 1) * pageSize()),
  );
  const selectedOnPage = createMemo(
    () => paginated().filter((row) => props.selectedKeys.has(row.key)).length,
  );
  const allSelected = () => selectedOnPage() === paginated().length;
  const emptyBecauseFiltered = () =>
    rawRows().length === 0 &&
    (normalizeLowercaseStringOrEmpty(props.searchQuery).length > 0 ||
      parseStrictPositiveInteger(props.activeMinutes) !== undefined ||
      !props.includeGlobal);
  const emptyStateMessage = () =>
    t(
      emptyBecauseFiltered()
        ? "sessionsView.noSessionsMatchFilters"
        : props.statusFilter === "archived"
          ? "sessionsView.noArchivedSessions"
          : props.statusFilter === "active"
            ? "sessionsView.noActiveSessions"
            : "sessionsView.noSessions",
    );

  const entries = createMemo<SessionEntry[]>(() => {
    const grouped = groups();
    if (!grouped) {
      return paginated().map((row) => ({ key: row.key, row }));
    }
    const keys = new Set(paginated().map((row) => row.key));
    return grouped.flatMap((group) => {
      const rows = group.rows.filter((row) => keys.has(row.key));
      if (!rows.length && group.rows.length) {
        return [];
      }
      const groupEntries: SessionEntry[] = [{ key: `group:${group.id}`, group }];
      for (const row of rows) {
        groupEntries.push({ key: row.key, row });
      }
      return groupEntries;
    });
  });
  function StatusRows() {
    return (
      <>
        {isPending(props.readRoster) && !props.result ? (
          <SkeletonRows columnCount={sessionsTableColumnCount(props)} />
        ) : isPending(props.readRoster) ||
          !props.readRoster().ok ||
          props.error ||
          !props.result ||
          paginated().length > 0 ? undefined : (
          <tr>
            <td colspan={sessionsTableColumnCount(props)} class="data-table-empty-cell">
              <div class="data-table-empty-state" role="status" aria-live="polite">
                <div class="data-table-empty-state__message">
                  <Icon name={emptyBecauseFiltered() ? "search" : "messageSquare"} />
                  <span>{emptyStateMessage()}</span>
                </div>
                {emptyBecauseFiltered() ? (
                  <button class="btn btn--sm" onClick={() => props.onClearFilters()}>
                    {t("sessionsView.showAll")}
                  </button>
                ) : undefined}
              </div>
            </td>
          </tr>
        )}
      </>
    );
  }
  return (
    <>
      {props.selectedKeys.size > 0 ? (
        <div class="data-table-bulk-bar">
          <span>{t("sessionsView.selected", { count: String(props.selectedKeys.size) })}</span>
          <button class="btn btn--sm" onClick={() => props.onDeselectAll()}>
            {t("common.unselect")}
          </button>
          <button
            class="btn btn--sm danger"
            disabled={props.loading || Boolean(props.deleteSelectedDisabledReason)}
            title={props.deleteSelectedDisabledReason ?? undefined}
            onClick={() => {
              void props.onDeleteSelected();
            }}
          >
            <Icon name="trash" /> {t("sessionsView.deleteSelected")}
          </button>
        </div>
      ) : undefined}

      <div class="data-table-container">
        <table
          class="data-table sessions-table"
          aria-rowcount={
            entries().length +
            1 +
            Number(paginated().some((row) => row.key === props.expandedSessionKey))
          }
        >
          <thead>
            <tr>
              <th class="data-table-checkbox-col">
                {paginated().length > 0 ? (
                  <input
                    type="checkbox"
                    checked={allSelected()}
                    prop:indeterminate={selectedOnPage() > 0 && !allSelected()}
                    onChange={() => {
                      const update = allSelected() ? props.onDeselectPage : props.onSelectPage;
                      update(paginated().map((r) => r.key));
                    }}
                    aria-label={t("sessionsView.selectAllOnPage")}
                  />
                ) : undefined}
              </th>
              <SortHeader
                {...props}
                column="key"
                label={t("sessionsView.session")}
                extraClass="data-table-key-col"
              />
              {props.allAgentsScope ? (
                <th class="session-agent-col">{t("sessionsView.agent")}</th>
              ) : undefined}
              {props.groupBy === "category" ? <th>{t("sessionsView.group")}</th> : undefined}
              <SortHeader {...props} column="updated" label={t("sessionsView.updated")} />
              <th class="session-actions-col">
                <span class="sr-only">{t("sessionsView.actions")}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            <Loading
              fallback={
                !props.result ? (
                  <SkeletonRows columnCount={sessionsTableColumnCount(props)} />
                ) : null
              }
            >
              <StatusRows />
            </Loading>
          </tbody>
          <SessionWindow {...props} entries={entries()} />
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
            <SettingsSelect
              class="data-table-pagination__size"
              aria-label={t("sessionsView.pageSize")}
              value={pageSizeValue()}
              options={PAGE_SIZES.map((size) => ({
                value: String(size),
                label: t("sessionsView.rowsPerPage", { count: String(size) }),
              }))}
              onChange={(e) => props.onPageSizeChange(Number(e.currentTarget.value))}
            />
            {props.result?.hasMore && props.result.nextOffset != null ? (
              <button disabled={props.loading} onClick={() => props.onLoadMore()}>
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
