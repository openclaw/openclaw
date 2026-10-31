import type { JSX } from "@solidjs/web";
import {
  defaultRangeExtractor,
  elementScroll,
  observeElementOffset,
  observeElementRect,
  Virtualizer,
  type VirtualItem,
} from "@tanstack/virtual-core";
import {
  Errored,
  For,
  Loading,
  Show,
  createMemo,
  createSignal,
  isPending,
  latest,
  onSettled,
} from "solid-js";
import type { SessionsListResult } from "../../api/types.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { HubPageHeader } from "../../components/solid/hub-page-header.tsx";
import { Icon } from "../../components/solid/icon.tsx";
import { PanelRefreshStatus } from "../../components/solid/panel-refresh-status.tsx";
import { SettingsWorkspace } from "../../components/solid/settings-workspace.tsx";
import { registerDashboardsEnglish } from "../../i18n/locales/en-dashboards.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { formatRelativeTimestamp } from "../../lib/format.ts";
import { shouldHandleNavigationClick } from "../../lib/navigation-click.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { createLayoutMeasurement } from "../../lib/reactive/layout-measurement.ts";
import { resolveSessionDisplayName } from "../../lib/session-display.ts";
import {
  isSessionKeyAddressable,
  sessionNavigationTarget,
} from "../../lib/sessions/route-navigation.ts";
import "../../styles/dashboards.css";
import { DashboardPreview } from "./dashboard-preview.tsx";

registerDashboardsEnglish();

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
        ].some((value) => value?.toLocaleLowerCase().includes(query))
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

// Native Tab enters at either endpoint, then the neighboring track is ready.
function pinnedTracks(rowCount: number, columns: number, focusedIndex: number | undefined) {
  const count = Math.ceil(rowCount / columns);
  const pinned = new Set([0, count - 1]);
  if (focusedIndex !== undefined) {
    const track = Math.floor(focusedIndex / columns);
    for (const index of [track - 1, track, track + 1]) {
      if (index >= 0 && index < count) {
        pinned.add(index);
      }
    }
  }
  return pinned;
}

function DashboardGrid(props: {
  data: DashboardsRouteData;
  rows: DashboardRow[];
  handlers: DashboardGalleryHandlers;
  gatewaySnapshot?: ApplicationGatewaySnapshot;
}) {
  function DashboardCard(childProps: {
    row: DashboardRow;
    contentRef: (element: HTMLElement) => void;
  }) {
    const target = createMemo(() =>
      isSessionKeyAddressable(childProps.row.key, props.data.globalScope)
        ? sessionNavigationTarget({
            face: "dashboard",
            sessionKey: childProps.row.key,
            fallbackAgentId:
              childProps.row.key === "global"
                ? childProps.row.agentId?.trim() || props.data.fallbackAgentId
                : props.data.fallbackAgentId,
            basePath: props.data.basePath,
            row: childProps.row,
            mainKey: props.data.mainKey,
          })
        : null,
    );
    const author = () => dashboardAuthor(childProps.row, props.data.fallbackAgentId);
    const title = createMemo(() => resolveSessionDisplayName(childProps.row.key, childProps.row));
    const Content = () => (
      <>
        <div class="dashboard-preview" aria-hidden="true" inert>
          <DashboardPreview
            gatewaySnapshot={props.gatewaySnapshot}
            sessionKey={childProps.row.key}
            agentId={childProps.row.agentId}
          />
        </div>
        <div class="dashboard-card__body">
          <div class="dashboard-card__heading">
            <h2>{title()}</h2>
            <Show when={childProps.row.status === "running"}>
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
            {childProps.row.updatedAt
              ? t("dashboardsPage.updated", {
                  time: formatRelativeTimestamp(childProps.row.updatedAt),
                })
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
      <article class="dashboard-card" data-dashboard-session={childProps.row.key}>
        <Show
          when={target()}
          fallback={
            <div class="dashboard-card__main" ref={childProps.contentRef}>
              <Content />
            </div>
          }
        >
          {(destination) => (
            <a
              ref={childProps.contentRef}
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

  let grid!: HTMLDivElement;
  let scroller: HTMLElement | null = null;
  let columns = 3;
  let gap = 16;
  let itemKeys:
    | { rows: DashboardRow[]; columns: number; getItemKey: (index: number) => string }
    | undefined;
  const content = new Map<string, HTMLElement>();
  const [focused, setFocused] = createSignal<string>();
  const [view, setView] = createSignal<{
    tracks: VirtualItem[];
    height: number;
    columns: number;
    gap: number;
    available: boolean;
  }>({ tracks: [], height: 0, columns, gap, available: true });
  const windowed = createMemo(() => props.rows.length > 60 && view().available);
  const indexes = createMemo(() => new Map(props.rows.map((row, index) => [row.key, index])));
  const publish = () => {
    const tracks = virtualizer.getVirtualItems();
    const height = virtualizer.getTotalSize();
    setView((previous) =>
      previous.height === height &&
      previous.columns === columns &&
      previous.gap === gap &&
      previous.available === Boolean(scroller) &&
      previous.tracks.length === tracks.length &&
      previous.tracks.every((track, index) => {
        const next = tracks[index]!;
        return track.index === next.index && track.start === next.start && track.size === next.size;
      })
        ? previous
        : { tracks, height, columns, gap, available: Boolean(scroller) },
    );
  };
  const virtualizer = new Virtualizer<HTMLElement, HTMLDivElement>({
    count: 0,
    enabled: false,
    getScrollElement: () => scroller,
    estimateSize: () => 320,
    observeElementRect,
    observeElementOffset,
    scrollToFn: elementScroll,
    overscan: 2,
    onChange: publish,
  });
  onSettled(() => {
    const { _didMount: mountVirtualizer } = virtualizer;
    return mountVirtualizer();
  });
  const measure = createLayoutMeasurement(
    () => ({ rows: props.rows, indexes: indexes(), focused: focused(), windowed: windowed() }),
    (next) => {
      if (!next) {
        return undefined;
      }
      const viewport = grid.closest<HTMLElement>(".content");
      const style = getComputedStyle(grid);
      const nextColumns = style.gridTemplateColumns.split(" ").filter(Boolean).length || 3;
      const nextGap = Number.parseFloat(style.rowGap) || 0;
      // A new callback invalidates all tracks; only row order or column count changes their keys.
      if (itemKeys?.rows !== next.rows || itemKeys.columns !== nextColumns) {
        const rows = next.rows;
        itemKeys = {
          rows,
          columns: nextColumns,
          getItemKey: (index) => rows[index * nextColumns]!.key,
        };
      }
      const { getItemKey } = itemKeys;
      const margin = viewport
        ? grid.getBoundingClientRect().top -
          viewport.getBoundingClientRect().top +
          viewport.scrollTop
        : 0;
      const heights = new Map<number, number>();
      for (const [key, element] of content) {
        const index = next.indexes.get(key);
        if (index !== undefined) {
          const track = Math.floor(index / nextColumns);
          // Measure intrinsic content, not the stretched card: a track must also shrink.
          const height = element.getBoundingClientRect().height + 2;
          heights.set(track, Math.max(heights.get(track) ?? 0, height));
        }
      }
      const count = Math.ceil(next.rows.length / nextColumns);
      const pinned = pinnedTracks(
        next.rows.length,
        nextColumns,
        next.indexes.get(next.focused ?? ""),
      );
      return () => {
        scroller = viewport;
        if (columns !== nextColumns) {
          virtualizer.measure();
        }
        columns = nextColumns;
        gap = nextGap;
        virtualizer.setOptions({
          ...virtualizer.options,
          count,
          enabled: next.windowed && Boolean(viewport),
          getItemKey,
          gap,
          scrollMargin: margin,
          rangeExtractor: (range) =>
            [...new Set([...defaultRangeExtractor(range), ...pinned])].toSorted((a, b) => a - b),
        });
        const { _willUpdate: updateVirtualizer } = virtualizer;
        updateVirtualizer();
        for (const [index, height] of heights) {
          if (height > 2) {
            virtualizer.resizeItem(index, height);
          }
        }
        publish();
      };
    },
    {
      targets: () => [grid, ...(scroller ? [scroller] : []), ...content.values()],
      fonts: true,
    },
  );
  const tracks = createMemo(() => new Map(view().tracks.map((track) => [track.index, track])));
  const visible = createMemo(() => {
    if (!windowed()) {
      return props.rows;
    }
    if (view().tracks.length === 0) {
      return [...props.rows.slice(0, 12), ...props.rows.slice(-3)];
    }
    const pinned = pinnedTracks(props.rows.length, view().columns, indexes().get(focused() ?? ""));
    const trackIndexes = new Set([...view().tracks.map((track) => track.index), ...pinned]);
    return [...trackIndexes]
      .toSorted((left, right) => left - right)
      .flatMap((index) => props.rows.slice(index * view().columns, (index + 1) * view().columns));
  });
  function CardSlot(card: { row: DashboardRow }) {
    let element: HTMLElement;
    let key: string | undefined;
    const bindContent = (next: HTMLElement) => {
      element = next;
      if (key !== undefined) {
        content.set(key, next);
        measure();
      }
    };
    onSettled(() => {
      key = card.row.key;
      content.set(key, element);
      measure();
      return () => {
        if (key !== undefined && content.get(key) === element) {
          content.delete(key);
          measure();
        }
      };
    });
    const index = () => indexes().get(card.row.key)!;
    const position = (): JSX.CSSProperties | undefined => {
      if (!windowed()) {
        return undefined;
      }
      const trackIndex = Math.floor(index() / view().columns);
      const track = tracks().get(trackIndex);
      return {
        position: "absolute",
        top: `${(track?.start ?? trackIndex * (320 + view().gap)) - virtualizer.options.scrollMargin}px`,
        "inset-inline-start": `calc(${index() % view().columns} * (100% + ${view().gap}px) / ${view().columns})`,
        width: `calc((100% - ${(view().columns - 1) * view().gap}px) / ${view().columns})`,
        height: `${track?.size ?? 320}px`,
      };
    };
    return (
      <div
        class="dashboards-grid__item"
        role="listitem"
        aria-posinset={index() + 1}
        aria-setsize={props.rows.length}
        style={position()}
        onFocusIn={() => setFocused(card.row.key)}
      >
        <DashboardCard row={card.row} contentRef={bindContent} />
      </div>
    );
  }
  return (
    <div
      ref={(element) => (grid = element)}
      class="dashboards-grid"
      role="list"
      style={
        windowed()
          ? {
              position: "relative",
              height: `${view().height || Math.ceil(props.rows.length / 3) * 336}px`,
            }
          : undefined
      }
    >
      <For each={visible()} keyed={(row) => row.key}>
        {(row) => <CardSlot row={row()} />}
      </For>
    </div>
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
            <DashboardGrid
              data={props.data}
              rows={visibleRows()}
              handlers={props.handlers}
              gatewaySnapshot={props.gatewaySnapshot}
            />
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
  readReady: () => void;
  filters: DashboardGalleryFilters;
  handlers: DashboardGalleryHandlers;
  gatewaySnapshot?: ApplicationGatewaySnapshot;
}) {
  const readiness = () => {
    latest(props.readReady);
    return null;
  };
  return (
    <>
      <HubPageHeader
        active="dashboards"
        wide
        docsUrl="https://docs.openclaw.ai/web/dashboards"
        class="dashboards-header"
        actions={
          <Show when={props.data?.result}>
            <div class="dashboards-header__count">
              <strong>{props.data?.result?.sessions.length}</strong>
              <span>{t("dashboardsPage.totalLabel")}</span>
            </div>
          </Show>
        }
      />
      <SettingsWorkspace>
        <Loading
          on={!props.data?.result && !props.data?.error}
          fallback={<DashboardGallerySkeleton />}
        >
          <Show
            when={!props.data?.result && isPending(props.readReady)}
            fallback={
              <Errored
                fallback={(error) => (
                  <PanelRefreshStatus
                    status={{
                      error: formatUiError(error()),
                      hasLoaded: Boolean(props.data?.result),
                      stale: Boolean(props.data?.result),
                      awaitingGateway: false,
                    }}
                    errorMessage={t("dashboardsPage.loadError", {
                      error: formatUiError(error()),
                    })}
                  />
                )}
              >
                {readiness()}
              </Errored>
            }
          >
            <DashboardGallerySkeleton />
          </Show>
          <Show when={props.data?.result ? props.data : undefined}>
            {(data) => (
              <DashboardList
                data={data()}
                filters={props.filters}
                handlers={props.handlers}
                gatewaySnapshot={props.gatewaySnapshot}
              />
            )}
          </Show>
        </Loading>
      </SettingsWorkspace>
    </>
  );
}
