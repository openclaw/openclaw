import { createMemo, For } from "solid-js";
import { Icon } from "../../components/solid/icon.tsx";
import { syncPopoverExpanded, syncPopoverLabel } from "../../components/web-awesome-popover.ts";
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

export type SessionsAdvancedFiltersProps = {
  activeMinutes: string;
  limit: string;
  includeGlobal: boolean;
  includeUnknown: boolean;
  statusFilter: SessionArchivedFilter;
  groupBy: SessionsGroupBy;
  /** Multi-identity gateways only; hides the Person mode elsewhere. */
  personGroupingAvailable: boolean;
  groupWriteDisabledReason?: string;
  onFiltersChange: (next: {
    activeMinutes: string;
    limit: string;
    includeGlobal: boolean;
    includeUnknown: boolean;
  }) => void;
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
  const active = createMemo(
    () =>
      props.activeMinutes.trim() !== "" ||
      props.limit.trim() !== String(SESSIONS_PAGE_DEFAULT_LIMIT) ||
      !props.includeGlobal ||
      props.includeUnknown ||
      props.groupBy !== "none",
  );
  return (
    <>
      <button
        id="sessions-filter-popover-trigger"
        type="button"
        class={["btn btn--sm sessions-filter-popover__trigger", { active: active() }]}
        title={t("sessionsView.filters")}
        aria-label={t("sessionsView.filters")}
        aria-haspopup="dialog"
        aria-expanded="false"
      >
        <Icon name="listFilter" />
      </button>
      <wa-popover
        ref={syncPopoverLabel}
        class="sessions-filter-popover"
        for="sessions-filter-popover-trigger"
        placement="bottom-end"
        without-arrow
        onWa-show={syncPopoverExpanded}
        onWa-hide={syncPopoverExpanded}
      >
        <div class="sessions-filter-popover__panel">
          <div class="sessions-filter-popover__fields">
            <For each={filterInputs}>
              {([key, suffix, labelKey]) => {
                const value = createMemo(() => props[key]);
                return (
                  <openclaw-tooltip
                    prop:content={
                      key === "activeMinutes"
                        ? t("sessionsView.activeTooltip", { count: props.activeMinutes.trim() })
                        : t("sessionsView.limitTooltip")
                    }
                  >
                    <label class="session-filter-field">
                      <span class="session-filter-label">{t(labelKey)}</span>
                      <input
                        class={`session-filter-input session-filter-input--${suffix}`}
                        placeholder={
                          key === "activeMinutes" ? t("sessionsView.minutesPlaceholder") : undefined
                        }
                        value={value()}
                        disabled={key === "activeMinutes" && props.statusFilter !== "active"}
                        onInput={(event: Event) => {
                          if (event.currentTarget instanceof HTMLInputElement) {
                            updateFilter(key, event.currentTarget.value);
                          }
                        }}
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
              {([key, label, tooltip]) => (
                <openclaw-tooltip prop:content={tooltip}>
                  <label
                    class={[
                      "session-filter-check session-filter-toggle",
                      { "session-filter-check--active": props[key] },
                    ]}
                  >
                    <input
                      name={key}
                      class="session-filter-check__input"
                      type="checkbox"
                      checked={props[key]}
                      onChange={(event: Event) => {
                        if (event.currentTarget instanceof HTMLInputElement) {
                          updateFilter(key, event.currentTarget.checked);
                        }
                      }}
                    />
                    <span class="session-filter-check__mark" aria-hidden="true">
                      <Icon name="check" />
                    </span>
                    <span class="session-filter-check__label">{label}</span>
                  </label>
                </openclaw-tooltip>
              )}
            </For>
          </div>
          <label class="session-groupby">
            <span class="session-groupby__label">{t("sessionsView.groupBy")}</span>
            <select
              class="session-groupby__select"
              onChange={(event: Event) => {
                if (event.currentTarget instanceof HTMLSelectElement) {
                  props.onGroupByChange(normalizeSessionsGroupBy(event.currentTarget.value));
                }
              }}
            >
              <For
                each={SESSION_GROUP_MODES.filter(
                  (mode) => mode !== "person" || props.personGroupingAvailable,
                )}
              >
                {(mode) => (
                  <option value={mode} selected={props.groupBy === mode}>
                    {t(SESSION_GROUP_MODE_LABELS[mode])}
                  </option>
                )}
              </For>
            </select>
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
        </div>
      </wa-popover>
    </>
  );
}

export function handleSessionsSearchKeydown(
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
    document.openClawModalLayers?.size ||
    document.querySelector(
      "dialog[open], [aria-modal='true'], openclaw-menu-surface, wa-dropdown[open], wa-popover[open], wa-select[open]",
    )
  ) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  props.onSearchChange("");
}

export function clearSessionsSearch(event: MouseEvent, onSearchChange: (query: string) => void) {
  // SAFETY: This listener is bound directly to the clear button.
  const input = (event.currentTarget as HTMLElement).parentElement?.querySelector("input");
  input?.focus({ preventScroll: true });
  onSearchChange("");
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
