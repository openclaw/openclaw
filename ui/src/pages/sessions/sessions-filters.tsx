import { createMemo, For } from "solid-js";
import { hasMenuSurface } from "../../components/menu-surface.ts";
import { hasModalSurface, registryFor } from "../../components/overlay-registry.ts";
import { Icon } from "../../components/solid/icon.tsx";
import { Popover, type PopoverHandle } from "../../components/solid/popover.tsx";
import { SettingsSelect } from "../../components/solid/settings-select.tsx";
import { SettingsSegmented } from "../../components/solid/settings-ui.tsx";
import { registerSessionOrganizationEnglish } from "../../i18n/locales/en-session-organization.ts";
import { t } from "../../lib/reactive/i18n.ts";
import "../../components/tooltip.ts";
import { SESSION_DRAG_MIME } from "../../lib/sessions/drag.ts";
import {
  normalizeSessionsGroupBy,
  SESSION_GROUP_MODES,
  type SessionsGroupBy,
} from "../../lib/sessions/grouping.ts";
import type { SessionArchivedFilter } from "../../lib/sessions/index.ts";
import { SESSIONS_PAGE_DEFAULT_LIMIT } from "../../lib/sessions/session-requests.ts";
import type { JSX } from "../../types/solid-elements.js";

registerSessionOrganizationEnglish();

export type SessionsAdvancedFiltersProps = {
  activeMinutes: string;
  limit: string;
  includeGlobal: boolean;
  includeUnknown: boolean;
  searchQuery: string;
  sessionMenu: { key: string } | null;
  statusFilter: SessionArchivedFilter;
  groupBy: SessionsGroupBy;
  loading: boolean;
  archivedCount: number;
  deleteArchivedDisabledReason?: string;
  /** Multi-identity gateways only; hides the Person mode elsewhere. */
  personGroupingAvailable: boolean;
  groupWriteDisabledReason?: string;
  onFiltersChange: (next: {
    activeMinutes: string;
    limit: string;
    includeGlobal: boolean;
    includeUnknown: boolean;
  }) => void;
  onSearchChange: (query: string) => void;
  onStatusFilterChange: (statusFilter: SessionArchivedFilter) => void;
  onDeleteAllArchived: () => void;
  onGroupByChange: (mode: SessionsGroupBy) => void;
  onRequestNewCategory: (sessionKey?: string) => void;
};

const SESSION_GROUP_MODE_LABELS = {
  none: "sessionsView.groupByNone",
  category: "sessionsView.groupByCategory",
  person: "sessionsView.groupByPerson",
  channel: "sessionsView.groupByChannel",
  kind: "sessionsView.groupByKind",
  agent: "sessionsView.groupByAgent",
  date: "sessionsView.groupByDate",
} as const satisfies Record<SessionsGroupBy, string>;

export function SessionsAdvancedFilters(props: SessionsAdvancedFiltersProps): JSX.Element {
  let searchInput!: HTMLInputElement;
  let popover: PopoverHandle | undefined;
  // Archived timestamps are intentionally stale, so recency only applies to the active view.
  const filterInputs = [
    ["activeMinutes", "minutes", "sessionsView.active"],
    ["limit", "limit", "sessionsView.limit"],
  ] as const;
  const sourceFilters = createMemo(
    () =>
      [
        ["includeGlobal", t("sessionsView.global"), t("sessionsView.globalTooltip")],
        ["includeUnknown", t("sessionsView.unknown"), t("sessionsView.unknownTooltip")],
      ] as const,
  );
  const updateFilter = (
    key: keyof Parameters<SessionsAdvancedFiltersProps["onFiltersChange"]>[0],
    value: string | boolean,
  ) =>
    props.onFiltersChange({
      activeMinutes: props.activeMinutes,
      limit: props.limit,
      includeGlobal: props.includeGlobal,
      includeUnknown: props.includeUnknown,
      [key]: value,
    });
  const active = () =>
    props.activeMinutes.trim() !== "" ||
    props.limit.trim() !== String(SESSIONS_PAGE_DEFAULT_LIMIT) ||
    !props.includeGlobal ||
    props.includeUnknown ||
    props.searchQuery.trim() !== "" ||
    props.statusFilter !== "active" ||
    props.groupBy !== "none";
  return (
    <Popover
      id="sessions-filter-popover"
      triggerId="sessions-filter-popover-trigger"
      triggerClass={[
        "btn btn--xs btn--icon sessions-toolbar__icon sessions-filter-popover__trigger",
        { active: active() },
      ]}
      trigger={<Icon name="listFilter" />}
      ref={(handle) => {
        popover = handle;
      }}
      label={t("sessionsView.filters")}
      class="sessions-filter-popover"
      placement="bottom-end"
      onOpenChange={(open) => {
        if (open) {
          popover?.overlay.surface.focus({ preventScroll: true });
        }
      }}
    >
      <div class="sessions-filter-popover__panel">
        <div class="data-table-search sessions-filter-popover__search">
          <Icon name="search" />
          <input
            ref={(element) => (searchInput = element)}
            type="text"
            aria-label={t("sessionsView.searchPlaceholder")}
            placeholder={t("sessionsView.searchPlaceholder")}
            value={props.searchQuery}
            onInput={(event) => props.onSearchChange(event.currentTarget.value)}
            onKeyDown={(event: KeyboardEvent) => handleSessionsSearchKeydown(event, props)}
          />
          <button
            type="button"
            class="sessions-filter-popover__clear"
            aria-label={t("sessionsView.clearSearch")}
            hidden={!props.searchQuery}
            disabled={!props.searchQuery}
            onClick={() => {
              searchInput.focus({ preventScroll: true });
              props.onSearchChange("");
            }}
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
        <div class="sessions-filter-popover__fields">
          <For each={filterInputs}>
            {([key, suffix, labelKey]) => {
              let input: HTMLInputElement | undefined;
              const value = createMemo(() => props[key]);
              return (
                <openclaw-tooltip
                  prop:descriptionTarget={() => input ?? null}
                  prop:content={
                    key === "activeMinutes"
                      ? t("sessionsView.activeTooltip", { count: props.activeMinutes.trim() })
                      : t("sessionsView.limitTooltip")
                  }
                >
                  <label class="session-filter-field">
                    <span class="session-filter-label">{t(labelKey)}</span>
                    <input
                      ref={(element) => (input = element)}
                      class={["session-filter-input", `session-filter-input--${suffix}`]}
                      placeholder={
                        key === "activeMinutes" ? t("sessionsView.minutesPlaceholder") : undefined
                      }
                      value={value()}
                      disabled={key === "activeMinutes" && props.statusFilter !== "active"}
                      onInput={(event) => updateFilter(key, event.currentTarget.value)}
                    />
                  </label>
                </openclaw-tooltip>
              );
            }}
          </For>
        </div>
        <div
          class="session-filter-toggle-group"
          role="group"
          aria-label={t("sessionsView.sourceFilters")}
        >
          <For each={sourceFilters()}>
            {([key, label, tooltip]) => {
              let input: HTMLInputElement | undefined;
              return (
                <openclaw-tooltip
                  prop:content={tooltip}
                  prop:descriptionTarget={() => input ?? null}
                >
                  <label
                    class={[
                      "session-filter-check session-filter-toggle",
                      { "session-filter-check--active": props[key] },
                    ]}
                  >
                    <input
                      ref={(element) => (input = element)}
                      name={key}
                      class="session-filter-check__input"
                      type="checkbox"
                      checked={props[key]}
                      onChange={(event) => updateFilter(key, event.currentTarget.checked)}
                    />
                    <span class="session-filter-check__mark" aria-hidden="true">
                      <Icon name="check" />
                    </span>
                    <span class="session-filter-check__label">{label}</span>
                  </label>
                </openclaw-tooltip>
              );
            }}
          </For>
        </div>
        <label class="session-groupby">
          <span class="session-groupby__label">{t("sessionsView.groupBy")}</span>
          <SettingsSelect
            class="session-groupby__select"
            value={props.groupBy}
            options={SESSION_GROUP_MODES.filter(
              (mode) => mode !== "person" || props.personGroupingAvailable,
            ).map((mode) => ({ value: mode, label: t(SESSION_GROUP_MODE_LABELS[mode]) }))}
            onChange={(event) =>
              props.onGroupByChange(normalizeSessionsGroupBy(event.currentTarget.value))
            }
          />
        </label>
        {props.groupBy === "category" ? (
          <button
            class="btn btn--sm"
            disabled={Boolean(props.groupWriteDisabledReason)}
            title={props.groupWriteDisabledReason ?? undefined}
            onClick={() => props.onRequestNewCategory()}
          >
            <Icon name="plus" /> {t("sessionsView.newGroup")}
          </button>
        ) : undefined}
        {props.statusFilter === "archived" ? (
          <button
            class="btn btn--sm danger"
            disabled={
              props.loading ||
              props.archivedCount === 0 ||
              Boolean(props.deleteArchivedDisabledReason)
            }
            title={props.deleteArchivedDisabledReason}
            onClick={() => props.onDeleteAllArchived()}
          >
            <Icon name="trash" /> {t("sessionsView.deleteAllArchived")}
          </button>
        ) : undefined}
      </div>
    </Popover>
  );
}

function handleSessionsSearchKeydown(
  event: KeyboardEvent,
  props: {
    sessionMenu: { key: string } | null;
    onSearchChange: (query: string) => void;
  },
) {
  // SAFETY: This listener is bound directly to the search input.
  const input = event.currentTarget as HTMLInputElement;
  const document = input.ownerDocument;
  if (
    event.key !== "Escape" ||
    event.defaultPrevented ||
    event.isComposing ||
    event.keyCode === 229 ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    document.activeElement !== input ||
    !input.value ||
    props.sessionMenu ||
    hasModalSurface(document) ||
    registryFor(document).stack.some(
      (overlay) => overlay.open && overlay.id !== "sessions-filter-popover",
    ) ||
    hasMenuSurface(document)
  ) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  props.onSearchChange("");
}

// Drag-over highlighting toggles a class directly on the target row instead of
// re-rendering per dragover event; replacing rows mid-drag would cancel the drag.
function setDropTargetActive(event: DragEvent, active: boolean) {
  // SAFETY: These handlers are bound to the session row receiving the drag event.
  (event.currentTarget as HTMLElement | null)?.classList.toggle(
    "session-drop-target--active",
    active,
  );
}

export function categoryDropHandlers(
  props: Pick<SessionsAdvancedFiltersProps, "groupBy" | "groupWriteDisabledReason"> & {
    onAssignCategory: (key: string, category: string | null) => void;
  },
  category: string | null,
) {
  if (props.groupBy !== "category" || props.groupWriteDisabledReason) {
    return { dragover: undefined, dragleave: undefined, drop: undefined } as const;
  }
  const carriesSessionKey = (event: DragEvent) =>
    event.dataTransfer?.types.includes(SESSION_DRAG_MIME) === true;
  return {
    dragover: (event: DragEvent) => {
      if (!carriesSessionKey(event)) {
        return;
      }
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = "move";
      }
      setDropTargetActive(event, true);
    },
    dragleave: (event: DragEvent) => setDropTargetActive(event, false),
    drop: (event: DragEvent) => {
      if (!carriesSessionKey(event)) {
        return;
      }
      event.preventDefault();
      setDropTargetActive(event, false);
      const key = event.dataTransfer?.getData(SESSION_DRAG_MIME);
      if (key) {
        props.onAssignCategory(key, category);
      }
    },
  } as const;
}
