import { html, nothing } from "lit";
import { ref } from "lit/directives/ref.js";
import { icons } from "../../components/icons.ts";
import "../../components/tooltip.ts";
import { syncPopoverExpanded, syncPopoverLabel } from "../../components/web-awesome-popover.ts";
import { t } from "../../i18n/index.ts";
import { SESSION_DRAG_MIME } from "../../lib/sessions/drag.ts";
import {
  normalizeSessionsGroupBy,
  SESSION_GROUP_MODES,
  type SessionsGroupBy,
} from "../../lib/sessions/grouping.ts";
import type { SessionArchivedFilter } from "../../lib/sessions/index.ts";
import { SESSIONS_PAGE_DEFAULT_LIMIT } from "../../lib/sessions/session-requests.ts";

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

export function renderSessionsAdvancedFilters(props: SessionsAdvancedFiltersProps) {
  // Archived timestamps are intentionally stale, so recency only applies to the active view.
  const filterInputs = [
    [
      "activeMinutes",
      "minutes",
      t("sessionsView.active"),
      t("sessionsView.activeTooltip", { count: props.activeMinutes.trim() }),
      t("sessionsView.minutesPlaceholder"),
      props.statusFilter !== "active",
    ],
    ["limit", "limit", t("sessionsView.limit"), t("sessionsView.limitTooltip"), nothing, false],
  ] as const;
  const sourceFilters = [
    ["includeGlobal", t("sessionsView.global"), t("sessionsView.globalTooltip")],
    ["includeUnknown", t("sessionsView.unknown"), t("sessionsView.unknownTooltip")],
  ] as const;
  const { activeMinutes, limit, includeGlobal, includeUnknown } = props;
  const updateFilter = (
    key: keyof Parameters<SessionsAdvancedFiltersProps["onFiltersChange"]>[0],
    value: string | boolean,
  ) => props.onFiltersChange({ activeMinutes, limit, includeGlobal, includeUnknown, [key]: value });
  const active =
    activeMinutes.trim() !== "" ||
    limit.trim() !== String(SESSIONS_PAGE_DEFAULT_LIMIT) ||
    !includeGlobal ||
    includeUnknown ||
    props.groupBy !== "none";
  return html`
    <button
      id="sessions-filter-popover-trigger"
      type="button"
      class="btn btn--sm sessions-filter-popover__trigger ${active ? "active" : ""}"
      title=${t("sessionsView.filters")}
      aria-label=${t("sessionsView.filters")}
      aria-haspopup="dialog"
      aria-expanded="false"
    >
      ${icons.listFilter}
    </button>
    <wa-popover
      ${ref(syncPopoverLabel)}
      class="sessions-filter-popover"
      for="sessions-filter-popover-trigger"
      placement="bottom-end"
      without-arrow
      @wa-show=${syncPopoverExpanded}
      @wa-hide=${syncPopoverExpanded}
    >
      <div class="sessions-filter-popover__panel">
        <div class="sessions-filter-popover__fields">
          ${filterInputs.map(
            ([key, suffix, label, tooltip, placeholder, disabled]) => html`
              <openclaw-tooltip .content=${tooltip}>
                <label class="session-filter-field">
                  <span class="session-filter-label">${label}</span>
                  <input
                    class="session-filter-input session-filter-input--${suffix}"
                    placeholder=${placeholder}
                    .value=${props[key]}
                    ?disabled=${disabled}
                    @input=${(event: Event) => {
                      if (event.currentTarget instanceof HTMLInputElement) {
                        updateFilter(key, event.currentTarget.value);
                      }
                    }}
                  />
                </label>
              </openclaw-tooltip>
            `,
          )}
        </div>
        <div
          class="session-filter-toggle-group"
          role="group"
          aria-label=${t("sessionsView.sourceFilters")}
        >
          ${sourceFilters.map(
            ([key, label, tooltip]) => html`
              <openclaw-tooltip .content=${tooltip}>
                <label
                  class=${`session-filter-check session-filter-toggle${props[key] ? " session-filter-check--active" : ""}`}
                >
                  <input
                    name=${key}
                    class="session-filter-check__input"
                    type="checkbox"
                    .checked=${props[key]}
                    @change=${(event: Event) => {
                      if (event.currentTarget instanceof HTMLInputElement) {
                        updateFilter(key, event.currentTarget.checked);
                      }
                    }}
                  />
                  <span class="session-filter-check__mark" aria-hidden="true">${icons.check}</span>
                  <span class="session-filter-check__label">${label}</span>
                </label>
              </openclaw-tooltip>
            `,
          )}
        </div>
        <label class="session-groupby">
          <span class="session-groupby__label">${t("sessionsView.groupBy")}</span>
          <select
            class="session-groupby__select"
            @change=${(event: Event) => {
              if (event.currentTarget instanceof HTMLSelectElement) {
                props.onGroupByChange(normalizeSessionsGroupBy(event.currentTarget.value));
              }
            }}
          >
            ${SESSION_GROUP_MODES.filter(
              (mode) => mode !== "person" || props.personGroupingAvailable,
            ).map(
              (mode) => html`
                <option value=${mode} ?selected=${props.groupBy === mode}>
                  ${t(SESSION_GROUP_MODE_LABELS[mode])}
                </option>
              `,
            )}
          </select>
        </label>
        ${
          props.groupBy === "category"
            ? html`
                <button
                  class="btn btn--sm"
                  ?disabled=${Boolean(props.groupWriteDisabledReason)}
                  title=${props.groupWriteDisabledReason ?? nothing}
                  @click=${() => props.onRequestNewCategory()}
                >
                  ${icons.plus} ${t("sessionsView.newGroup")}
                </button>
              `
            : nothing
        }
      </div>
    </wa-popover>
  `;
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
// re-rendering per dragover event; lit re-renders mid-drag would cancel the drag.
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
    return { dragover: nothing, dragleave: nothing, drop: nothing } as const;
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
