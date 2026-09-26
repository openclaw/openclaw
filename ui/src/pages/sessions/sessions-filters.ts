import { html, nothing } from "lit";
import { ref } from "lit/directives/ref.js";
import { icons } from "../../components/icons.ts";
import "../../components/tooltip.ts";
import { syncPopoverLabel } from "../../components/web-awesome-popover.ts";
import { t } from "../../i18n/index.ts";
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

function groupModeLabel(mode: SessionsGroupBy): string {
  return t(SESSION_GROUP_MODE_LABELS[mode] ?? SESSION_GROUP_MODE_LABELS.none);
}

function renderFilterToggle(params: {
  name: string;
  checked: boolean;
  label: string;
  title: string;
  extraClass?: string;
  onChange: (checked: boolean) => void;
}) {
  const className = [
    "session-filter-check",
    "session-filter-toggle",
    params.extraClass ?? "",
    params.checked ? "session-filter-check--active" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return html`
    <openclaw-tooltip .content=${params.title}>
      <label class=${className}>
        <input
          name=${params.name}
          class="session-filter-check__input"
          type="checkbox"
          .checked=${params.checked}
          @change=${(event: Event) => {
            if (event.currentTarget instanceof HTMLInputElement) {
              params.onChange(event.currentTarget.checked);
            }
          }}
        />
        <span class="session-filter-check__mark" aria-hidden="true">${icons.check}</span>
        <span class="session-filter-check__label">${params.label}</span>
      </label>
    </openclaw-tooltip>
  `;
}

function setPreviousSiblingExpanded(event: Event, expanded: boolean) {
  if (event.currentTarget instanceof Element) {
    event.currentTarget.previousElementSibling?.setAttribute("aria-expanded", String(expanded));
  }
}

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
      @wa-show=${(event: Event) => setPreviousSiblingExpanded(event, true)}
      @wa-hide=${(event: Event) => setPreviousSiblingExpanded(event, false)}
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
          ${sourceFilters.map(([key, label, tooltip]) =>
            renderFilterToggle({
              name: key,
              checked: props[key],
              label,
              title: tooltip,
              onChange: (checked) => updateFilter(key, checked),
            }),
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
                  ${groupModeLabel(mode)}
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
