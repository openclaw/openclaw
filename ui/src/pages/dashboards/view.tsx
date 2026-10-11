import { For, Show, createMemo } from "solid-js";
import type { SessionsListResult } from "../../api/types.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { ShellLayoutBoundary } from "../../app/shell-layout-traits-solid.tsx";
import { Icon } from "../../components/solid/icon.tsx";
import { PanelRefreshStatus } from "../../components/solid/panel-refresh-status.tsx";
import { SettingsWorkspace } from "../../components/solid/settings-workspace.tsx";
import { formatRelativeTimestamp } from "../../lib/format.ts";
import { shouldHandleNavigationClick } from "../../lib/navigation-click.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { resolveSessionDisplayName } from "../../lib/session-display.ts";
import {
  isSessionKeyAddressable,
  sessionNavigationTarget,
} from "../../lib/sessions/route-navigation.ts";
import "../../styles/dashboards.css";
import { DashboardPreview } from "./dashboard-preview.ts";

export type DashboardsRouteData = {
  result: SessionsListResult | null;
  error: string | null;
  basePath: string;
  fallbackAgentId: string;
  mainKey: string;
  globalScope: boolean;
};

export type DashboardGalleryFilters = {
  query: string;
  ownerId: string;
  sort: "updated" | "title";
};

export type DashboardGalleryHandlers = {
  onFilterChange: (filter: Partial<DashboardGalleryFilters>) => void;
  onNavigate?: ApplicationContext["navigate"];
};

type DashboardRow = SessionsListResult["sessions"][number];

function dashboardAuthor(row: DashboardRow, fallbackAgentId: string) {
  const actor = row.createdActor ?? row.owner?.actor;
  const id = actor?.id?.trim() || row.agentId?.trim() || fallbackAgentId;
  return { id, label: actor?.label?.trim() || id };
}

function visibleDashboardRows(data: DashboardsRouteData, filters: DashboardGalleryFilters) {
  const query = filters.query.trim().toLocaleLowerCase();
  return (data.result?.sessions ?? [])
    .filter((row) => {
      const author = dashboardAuthor(row, data.fallbackAgentId);
      if (filters.ownerId && author.id !== filters.ownerId) {
        return false;
      }
      return (
        !query ||
        [
          resolveSessionDisplayName(row.key, row),
          author.label,
          row.lastMessagePreview,
          row.key,
        ].some((value) => typeof value === "string" && value.toLocaleLowerCase().includes(query))
      );
    })
    .toSorted((left, right) =>
      filters.sort === "title"
        ? resolveSessionDisplayName(left.key, left).localeCompare(
            resolveSessionDisplayName(right.key, right),
          )
        : (right.updatedAt ?? 0) - (left.updatedAt ?? 0),
    );
}

function DashboardCard(props: {
  data: DashboardsRouteData;
  row: DashboardRow;
  handlers: DashboardGalleryHandlers;
  gatewaySnapshot?: ApplicationGatewaySnapshot;
}) {
  const target = createMemo(() =>
    isSessionKeyAddressable(props.row.key, props.data.globalScope)
      ? sessionNavigationTarget({
          face: "dashboard",
          sessionKey: props.row.key,
          fallbackAgentId:
            props.row.key === "global"
              ? props.row.agentId?.trim() || props.data.fallbackAgentId
              : props.data.fallbackAgentId,
          basePath: props.data.basePath,
          row: props.row,
          mainKey: props.data.mainKey,
        })
      : null,
  );
  const author = createMemo(() => dashboardAuthor(props.row, props.data.fallbackAgentId));
  const title = createMemo(() => resolveSessionDisplayName(props.row.key, props.row));
  const Content = () => (
    <>
      <div class="dashboard-preview" aria-hidden="true" inert>
        <DashboardPreview
          gatewaySnapshot={props.gatewaySnapshot}
          sessionKey={props.row.key}
          agentId={props.row.agentId}
        />
      </div>
      <div class="dashboard-card__body">
        <div class="dashboard-card__heading">
          <h2>{title()}</h2>
          <Show when={props.row.status === "running"}>
            <span class="dashboard-card__live">
              <i />
              {t("dashboardsPage.live")}
            </span>
          </Show>
        </div>
        <div class="dashboard-card__author">
          <span class="dashboard-card__avatar" aria-hidden="true">
            {author().label.trim().charAt(0).toLocaleUpperCase() || "?"}
          </span>
          <span>{t("dashboardsPage.byAuthor", { author: author().label })}</span>
        </div>
      </div>
      <footer class="dashboard-card__footer">
        <span>
          {props.row.updatedAt
            ? t("dashboardsPage.updated", { time: formatRelativeTimestamp(props.row.updatedAt) })
            : t("dashboardsPage.updatedUnknown")}
        </span>
        <Show when={target()}>
          <span class="dashboard-card__open" aria-hidden="true">
            <Icon name="arrowUpRight" />
          </span>
        </Show>
      </footer>
    </>
  );
  return (
    <article class="dashboard-card" data-dashboard-session={props.row.key}>
      <Show
        when={target()}
        fallback={
          <div class="dashboard-card__main">
            <Content />
          </div>
        }
      >
        {(destination) => (
          <a
            class="dashboard-card__main"
            href={destination().href}
            aria-label={title()}
            onClick={(event: MouseEvent) => {
              const current = target();
              if (current && props.handlers.onNavigate && shouldHandleNavigationClick(event)) {
                event.preventDefault();
                props.handlers.onNavigate("dashboard", current.options);
              }
            }}
          >
            <Content />
          </a>
        )}
      </Show>
    </article>
  );
}

function DashboardList(props: {
  data: DashboardsRouteData;
  filters: DashboardGalleryFilters;
  handlers: DashboardGalleryHandlers;
  gatewaySnapshot?: ApplicationGatewaySnapshot;
}) {
  const rows = createMemo(() => props.data.result?.sessions ?? []);
  const owners = createMemo(() =>
    Array.from(
      new Map(
        rows().map((row) => {
          const author = dashboardAuthor(row, props.data.fallbackAgentId);
          return [author.id, author] as const;
        }),
      ).values(),
    ).toSorted((left, right) => left.label.localeCompare(right.label)),
  );
  const visibleRows = createMemo(() => visibleDashboardRows(props.data, props.filters));
  return (
    <Show when={!(props.data.error && !props.data.result)}>
      <Show
        when={rows().length > 0}
        fallback={
          <section class="card stack" data-dashboards-empty role="status">
            <div class="list-title">{t("dashboardsPage.emptyTitle")}</div>
            <div class="card-sub">{t("dashboardsPage.emptyDescription")}</div>
          </section>
        }
      >
        <section class="dashboards-gallery" aria-label={t("tabs.dashboards")}>
          <div class="dashboards-toolbar">
            <label class="dashboards-search">
              <span aria-hidden="true">
                <Icon name="search" />
              </span>
              <span class="sr-only">{t("dashboardsPage.searchLabel")}</span>
              <input
                type="search"
                value={props.filters.query}
                placeholder={t("dashboardsPage.searchPlaceholder")}
                onInput={(event) =>
                  props.handlers.onFilterChange({ query: event.currentTarget.value })
                }
              />
            </label>
            <label class="dashboards-select">
              <span>{t("dashboardsPage.authorFilter")}</span>
              <select
                value={props.filters.ownerId}
                onChange={(event) =>
                  props.handlers.onFilterChange({ ownerId: event.currentTarget.value })
                }
              >
                <option value="">{t("dashboardsPage.allAuthors")}</option>
                <For each={owners()} keyed={(owner) => owner.id}>
                  {(owner) => <option value={owner().id}>{owner().label}</option>}
                </For>
              </select>
            </label>
            <label class="dashboards-select">
              <span>{t("dashboardsPage.sortLabel")}</span>
              <select
                value={props.filters.sort}
                onChange={(event) => {
                  const sort = event.currentTarget.value;
                  if (sort === "updated" || sort === "title") {
                    props.handlers.onFilterChange({ sort });
                  }
                }}
              >
                <option value="updated">{t("dashboardsPage.sortUpdated")}</option>
                <option value="title">{t("dashboardsPage.sortTitle")}</option>
              </select>
            </label>
          </div>
          <div class="dashboards-results" role="status">
            {t("dashboardsPage.resultCount", { count: String(visibleRows().length) })}
          </div>
          <Show
            when={visibleRows().length > 0}
            fallback={
              <div class="dashboards-no-results" data-dashboards-no-results>
                <span aria-hidden="true">
                  <Icon name="search" />
                </span>
                <strong>{t("dashboardsPage.noResultsTitle")}</strong>
                <span>{t("dashboardsPage.noResultsDescription")}</span>
              </div>
            }
          >
            <div class="dashboards-grid">
              <For each={visibleRows()} keyed={(row) => row.key}>
                {(row) => (
                  <DashboardCard
                    data={props.data}
                    row={row()}
                    handlers={props.handlers}
                    gatewaySnapshot={props.gatewaySnapshot}
                  />
                )}
              </For>
            </div>
          </Show>
        </section>
      </Show>
    </Show>
  );
}

function DashboardGallerySkeleton() {
  return (
    <section class="dashboards-gallery" aria-busy="true">
      <span class="sr-only" role="status">
        {t("common.loading")}
      </span>
      <div class="dashboards-loading" aria-hidden="true" inert>
        <div class="dashboards-toolbar">
          <div class="dashboards-search skeleton dashboards-loading__control" />
          <For each={[0, 1]}>
            {() => (
              <div class="dashboards-select dashboards-loading__select">
                <div class="skeleton skeleton-line dashboards-loading__label" />
                <div class="skeleton dashboards-loading__control" />
              </div>
            )}
          </For>
        </div>
        <div class="dashboards-results">
          <div class="skeleton skeleton-line dashboards-loading__label" />
        </div>
        <div class="dashboards-grid">
          <For each={[0, 1, 2, 3, 4, 5]}>
            {() => (
              <div class="dashboard-card">
                <div class="dashboard-preview skeleton" />
                <div class="dashboard-card__body">
                  <div class="skeleton skeleton-line skeleton-line--long dashboards-loading__title" />
                  <div class="dashboard-card__author">
                    <div class="dashboard-card__avatar skeleton" />
                    <div class="skeleton skeleton-line skeleton-line--medium" />
                  </div>
                </div>
                <div class="dashboard-card__footer">
                  <div class="skeleton skeleton-line skeleton-line--medium" />
                </div>
              </div>
            )}
          </For>
        </div>
      </div>
    </section>
  );
}

export function DashboardsView(props: {
  data?: DashboardsRouteData;
  filters: DashboardGalleryFilters;
  handlers: DashboardGalleryHandlers;
  gatewaySnapshot?: ApplicationGatewaySnapshot;
}) {
  return (
    <>
      <ShellLayoutBoundary traits={{ toolbarHeader: true }}>
        <section class="content-header dashboards-header">
          <div>
            <h1 class="page-title">{t("tabs.dashboards")}</h1>
            <div class="page-subtitle">{t("subtitles.dashboards")}</div>
          </div>
          <Show when={props.data?.result}>
            <div class="dashboards-header__count">
              <strong>{props.data?.result?.sessions.length}</strong>
              <span>{t("dashboardsPage.totalLabel")}</span>
            </div>
          </Show>
        </section>
      </ShellLayoutBoundary>
      <SettingsWorkspace>
        <Show
          when={props.data && (props.data.result || props.data.error) ? props.data : undefined}
          fallback={<DashboardGallerySkeleton />}
        >
          {(data) => (
            <>
              <PanelRefreshStatus
                status={{
                  error: data().error,
                  hasLoaded: data().result !== null,
                  stale: Boolean(data().result && data().error),
                  awaitingGateway: false,
                }}
                errorMessage={
                  data().error ? t("dashboardsPage.loadError", { error: data().error! }) : undefined
                }
              />
              <DashboardList
                data={data()}
                filters={props.filters}
                handlers={props.handlers}
                gatewaySnapshot={props.gatewaySnapshot}
              />
            </>
          )}
        </Show>
      </SettingsWorkspace>
    </>
  );
}
