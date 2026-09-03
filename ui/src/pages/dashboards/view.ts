import { buildControlUiFocusPath } from "@openclaw/session-url-contract";
import { html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import type { SessionsListResult } from "../../api/types.ts";
import { titleForRoute } from "../../app-navigation.ts";
import { icons } from "../../components/icons.ts";
import { renderPanelRefreshStatus } from "../../components/panel-refresh-status.ts";
import { renderSettingsPage, renderSettingsPageHeader } from "../../components/settings-ui.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { t } from "../../i18n/index.ts";
import { formatRelativeTimestamp } from "../../lib/format.ts";
import { resolveSessionDisplayName } from "../../lib/session-display.ts";
import { sessionNavigationTarget } from "../../lib/sessions/route-navigation.ts";
import type { DashboardPreviewLoader } from "./dashboard-preview.ts";
import type { DashboardsView } from "./page-state.ts";
import "./dashboard-preview.ts";
import "../../styles/dashboards.css";

export type DashboardsRouteData = {
  result: SessionsListResult | null;
  error: string | null;
  basePath: string;
  fallbackAgentId: string;
  mainKey: string;
};

type DashboardsSort = "updated" | "created" | "title";

export type DashboardGalleryFilters = {
  query: string;
  ownerId: string;
  sort: DashboardsSort;
};

export type DashboardGalleryState = {
  filters: DashboardGalleryFilters;
  view: DashboardsView;
  loadPreview?: DashboardPreviewLoader | null;
};

export type DashboardGalleryHandlers = {
  onQueryChange: (value: string) => void;
  onOwnerChange: (value: string) => void;
  onSortChange: (value: DashboardsSort) => void;
  onViewChange: (value: DashboardsView) => void;
};

type DashboardRow = SessionsListResult["sessions"][number];

const DASHBOARD_SORTS = [
  "updated",
  "created",
  "title",
] as const satisfies readonly DashboardsSort[];
const DASHBOARD_VIEWS = ["cards", "list"] as const satisfies readonly DashboardsView[];
const DEFAULT_STATE: DashboardGalleryState = {
  filters: { query: "", ownerId: "", sort: "updated" },
  view: "cards",
};
const NOOP_HANDLERS: DashboardGalleryHandlers = {
  onQueryChange: () => undefined,
  onOwnerChange: () => undefined,
  onSortChange: () => undefined,
  onViewChange: () => undefined,
};

function isDashboardsSort(value: string): value is DashboardsSort {
  return value === "updated" || value === "created" || value === "title";
}

function dashboardAuthor(row: DashboardRow, fallbackAgentId: string) {
  const actor = row.createdActor ?? row.owner?.actor;
  const id = actor?.id?.trim() || row.agentId?.trim() || fallbackAgentId;
  return { id, label: actor?.label?.trim() || id };
}

function visibleDashboardRows(data: DashboardsRouteData, filters: DashboardGalleryFilters) {
  const query = filters.query.trim().toLocaleLowerCase();
  const title = (row: DashboardRow) => resolveSessionDisplayName(row.key, row);
  return (data.result?.sessions ?? [])
    .filter((row) => {
      const author = dashboardAuthor(row, data.fallbackAgentId);
      if (filters.ownerId && author.id !== filters.ownerId) {
        return false;
      }
      return (
        !query ||
        [title(row), author.label, row.lastMessagePreview, row.key]
          .filter((value): value is string => typeof value === "string")
          .some((value) => value.toLocaleLowerCase().includes(query))
      );
    })
    .toSorted((left, right) => {
      switch (filters.sort) {
        case "title":
          return title(left).localeCompare(title(right));
        case "created":
          return (right.createdAt ?? 0) - (left.createdAt ?? 0);
        default:
          return (right.updatedAt ?? 0) - (left.updatedAt ?? 0);
      }
    });
}

// The footer timestamp follows the active sort so the order is legible at a glance.
function dashboardTimestamp(row: DashboardRow, sort: DashboardsSort) {
  if (sort === "created") {
    return row.createdAt
      ? t("dashboardsPage.created", { time: formatRelativeTimestamp(row.createdAt) })
      : t("dashboardsPage.createdUnknown");
  }
  return row.updatedAt
    ? t("dashboardsPage.updated", { time: formatRelativeTimestamp(row.updatedAt) })
    : t("dashboardsPage.updatedUnknown");
}

function dashboardLinks(data: DashboardsRouteData, row: DashboardRow) {
  const navigation = {
    sessionKey: row.key,
    fallbackAgentId: data.fallbackAgentId,
    basePath: data.basePath,
    row,
    mainKey: data.mainKey,
  };
  const chat = sessionNavigationTarget({ ...navigation, face: "chat", dashboardExpanded: true });
  const dashboard = sessionNavigationTarget({ ...navigation, face: "dashboard" });
  return {
    href: chat.href,
    focusHref:
      buildControlUiFocusPath({ kind: "dashboard", path: dashboard.href }, data.basePath) ??
      dashboard.href,
  };
}

function renderPreview(row: DashboardRow, state: DashboardGalleryState) {
  return html`<openclaw-dashboard-preview
    .sessionKey=${row.key}
    .agentId=${row.agentId}
    .load=${state.loadPreview}
  ></openclaw-dashboard-preview>`;
}

function renderLive(row: DashboardRow) {
  return row.status === "running"
    ? html`<span class="dashboard-card__live"><i></i>${t("dashboardsPage.live")}</span>`
    : nothing;
}

function renderFocusLink(row: DashboardRow, focusHref: string) {
  return html`<a
    class="btn btn--sm btn--ghost dashboard-card__focus"
    data-dashboard-fullscreen=${row.key}
    href=${focusHref}
  >
    ${icons.maximize} ${t("dashboardsPage.openFocusMode")}
  </a>`;
}

function renderDashboardCard(
  data: DashboardsRouteData,
  row: DashboardRow,
  state: DashboardGalleryState,
) {
  const links = dashboardLinks(data, row);
  const author = dashboardAuthor(row, data.fallbackAgentId);
  const title = resolveSessionDisplayName(row.key, row);
  const initial = author.label.trim().charAt(0).toLocaleUpperCase() || "?";
  return html`<article class="dashboard-card" data-dashboard-session=${row.key}>
    <a class="dashboard-card__main" href=${links.href} aria-label=${title}>
      ${renderPreview(row, state)}
      <div class="dashboard-card__body">
        <div class="dashboard-card__heading">
          <h2>${title}</h2>
          ${renderLive(row)}
        </div>
        <div class="dashboard-card__author">
          <span class="dashboard-card__avatar" aria-hidden="true">${initial}</span>
          <span>${t("dashboardsPage.byAuthor", { author: author.label })}</span>
        </div>
      </div>
    </a>
    <footer class="dashboard-card__footer">
      <span>${dashboardTimestamp(row, state.filters.sort)}</span>
      ${renderFocusLink(row, links.focusHref)}
    </footer>
  </article>`;
}

function renderDashboardRow(
  data: DashboardsRouteData,
  row: DashboardRow,
  state: DashboardGalleryState,
) {
  const links = dashboardLinks(data, row);
  const author = dashboardAuthor(row, data.fallbackAgentId);
  const title = resolveSessionDisplayName(row.key, row);
  return html`<article class="dashboard-row" data-dashboard-session=${row.key}>
    <a class="dashboard-row__main" href=${links.href} aria-label=${title}>
      <span class="dashboard-card__heading">
        <h2>${title}</h2>
        ${renderLive(row)}
      </span>
      <span class="dashboard-row__meta">
        <span>${t("dashboardsPage.byAuthor", { author: author.label })}</span>
        <span>${dashboardTimestamp(row, state.filters.sort)}</span>
      </span>
    </a>
    ${renderFocusLink(row, links.focusHref)}
    <a class="dashboard-row__preview" href=${links.href} tabindex="-1" aria-hidden="true">
      ${renderPreview(row, state)}
    </a>
  </article>`;
}

function renderViewToggle(view: DashboardsView, handlers: DashboardGalleryHandlers) {
  const labels = { cards: t("dashboardsPage.viewCards"), list: t("dashboardsPage.viewList") };
  const viewIcons = { cards: icons.layoutGrid, list: icons.layoutCompact };
  return html`<div
    class="settings-segmented dashboards-view-toggle"
    role="group"
    aria-label=${t("dashboardsPage.viewLabel")}
  >
    ${DASHBOARD_VIEWS.map(
      (option) => html`<button
        type="button"
        class="settings-segmented__btn ${option === view ? "settings-segmented__btn--active" : ""}"
        data-dashboards-view=${option}
        aria-label=${labels[option]}
        aria-pressed=${String(option === view)}
        title=${labels[option]}
        @click=${() => handlers.onViewChange(option)}
      >
        ${viewIcons[option]}
      </button>`,
    )}
  </div>`;
}

function renderToolbar(
  data: DashboardsRouteData,
  filters: DashboardGalleryFilters,
  handlers: DashboardGalleryHandlers,
) {
  const owners = Array.from(
    new Map(
      (data.result?.sessions ?? []).map((row) => {
        const author = dashboardAuthor(row, data.fallbackAgentId);
        return [author.id, author] as const;
      }),
    ).values(),
  ).toSorted((left, right) => left.label.localeCompare(right.label));
  const sortLabels = {
    updated: t("dashboardsPage.sortUpdated"),
    created: t("dashboardsPage.sortCreated"),
    title: t("dashboardsPage.sortTitle"),
  };
  return html`<div class="dashboards-toolbar">
    <label class="dashboards-search">
      <span aria-hidden="true">${icons.search}</span>
      <span class="sr-only">${t("dashboardsPage.searchLabel")}</span>
      <input
        type="search"
        .value=${filters.query}
        placeholder=${t("dashboardsPage.searchPlaceholder")}
        @input=${(event: Event) => {
          if (event.currentTarget instanceof HTMLInputElement) {
            handlers.onQueryChange(event.currentTarget.value);
          }
        }}
      />
    </label>
    <label class="dashboards-select">
      <span>${t("dashboardsPage.authorFilter")}</span>
      <select
        .value=${filters.ownerId}
        @change=${(event: Event) => {
          if (event.currentTarget instanceof HTMLSelectElement) {
            handlers.onOwnerChange(event.currentTarget.value);
          }
        }}
      >
        <option value="">${t("dashboardsPage.allAuthors")}</option>
        ${owners.map((owner) => html`<option value=${owner.id}>${owner.label}</option>`)}
      </select>
    </label>
    <label class="dashboards-select">
      <span>${t("dashboardsPage.sortLabel")}</span>
      <select
        .value=${filters.sort}
        @change=${(event: Event) => {
          const value =
            event.currentTarget instanceof HTMLSelectElement ? event.currentTarget.value : "";
          if (isDashboardsSort(value)) {
            handlers.onSortChange(value);
          }
        }}
      >
        ${DASHBOARD_SORTS.map((sort) => html`<option value=${sort}>${sortLabels[sort]}</option>`)}
      </select>
    </label>
  </div>`;
}

function renderDashboardList(
  data: DashboardsRouteData,
  state: DashboardGalleryState,
  handlers: DashboardGalleryHandlers,
) {
  const rows = data.result?.sessions ?? [];
  if (data.error && !data.result) {
    return nothing;
  }
  if (rows.length === 0) {
    return html`<section class="card stack" data-dashboards-empty role="status">
      <div class="list-title">${t("dashboardsPage.emptyTitle")}</div>
      <div class="card-sub">${t("dashboardsPage.emptyDescription")}</div>
    </section>`;
  }
  const visibleRows = visibleDashboardRows(data, state.filters);
  const renderItem = state.view === "list" ? renderDashboardRow : renderDashboardCard;
  return html`<section class="dashboards-gallery" aria-label=${titleForRoute("dashboards")}>
    ${renderToolbar(data, state.filters, handlers)}
    <div class="dashboards-results" role="status">
      ${t("dashboardsPage.resultCount", { count: String(visibleRows.length) })}
    </div>
    ${
      visibleRows.length === 0
        ? html`<div class="dashboards-no-results" data-dashboards-no-results>
            <span aria-hidden="true">${icons.search}</span>
            <strong>${t("dashboardsPage.noResultsTitle")}</strong>
            <span>${t("dashboardsPage.noResultsDescription")}</span>
          </div>`
        : html`<div class="dashboards-${state.view}" data-dashboards-view=${state.view}>
            ${repeat(
              visibleRows,
              (row) => row.key,
              (row) => renderItem(data, row, state),
            )}
          </div>`
    }
  </section>`;
}

export function renderDashboards(
  data: DashboardsRouteData | undefined,
  onRetry: () => void,
  state: DashboardGalleryState = DEFAULT_STATE,
  handlers: DashboardGalleryHandlers = NOOP_HANDLERS,
) {
  const body = data
    ? html`
        ${renderPanelRefreshStatus({
          status: {
            error: data.error,
            hasLoaded: data.result !== null,
            stale: data.result !== null && data.error !== null,
          },
          errorMessage: data.error
            ? t("dashboardsPage.loadError", { error: data.error })
            : undefined,
          onRetry,
        })}
        ${renderDashboardList(data, state, handlers)}
      `
    : html`<section class="card" aria-busy="true">${t("common.loading")}</section>`;
  return html`
    ${renderSettingsPageHeader({
      title: titleForRoute("dashboards"),
      subtitle: t("subtitles.dashboards"),
      actions: html`
        ${
          data?.result
            ? html`<div class="dashboards-header__count">
                <strong>${data.result.sessions.length}</strong>
                <span>${t("dashboardsPage.totalLabel")}</span>
              </div>`
            : nothing
        }
        ${renderViewToggle(state.view, handlers)}
      `,
    })}
    ${renderSettingsWorkspace(renderSettingsPage(body, { wide: true }))}
  `;
}
