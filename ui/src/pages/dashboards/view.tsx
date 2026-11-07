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
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import { HubPageHeader } from "../../components/solid/hub-page-header.tsx";
import { Icon } from "../../components/solid/icon.tsx";
import { PanelRefreshStatus } from "../../components/solid/panel-refresh-status.tsx";
import { SettingsWorkspace } from "../../components/solid/settings-workspace.tsx";
import { registerDashboardsEnglish } from "../../i18n/locales/en-dashboards.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { createLayoutMeasurement } from "../../lib/reactive/layout-measurement.ts";
import { resolveSessionDisplayName } from "../../lib/session-display.ts";
import "../../styles/dashboards.css";
import { DashboardDisplayMenu } from "./dashboard-display-menu.tsx";
import {
  DashboardEntry,
  dashboardAuthor,
  dashboardGroups,
  type DashboardRow,
} from "./dashboard-entry.tsx";
import {
  DashboardAuthorChip,
  DashboardAuthorFilter,
  DashboardSearch,
  type DashboardAuthorOption,
} from "./dashboard-tools.tsx";
import type { DashboardGalleryFilters, DashboardGalleryHandlers } from "./gallery-filters.ts";

registerDashboardsEnglish();

export type DashboardsRouteData = {
  result: SessionsListResult | null;
  error: string | null;
  basePath: string;
  fallbackAgentId: string;
  mainKey: string;
  globalScope: boolean;
};

function dashboardAuthors(data: DashboardsRouteData): DashboardAuthorOption[] {
  const authors = new Map<string, DashboardAuthorOption>();
  for (const row of data.result?.sessions ?? []) {
    const author = dashboardAuthor(row, data.fallbackAgentId);
    const known = authors.get(author.id);
    authors.set(author.id, known ? { ...known, count: known.count + 1 } : { ...author, count: 1 });
  }
  return [...authors.values()];
}

function visibleDashboardRows(data: DashboardsRouteData, filters: DashboardGalleryFilters) {
  const query = filters.query.trim().toLocaleLowerCase().normalize("NFC");
  return (data.result?.sessions ?? [])
    .filter((row) => {
      const author = dashboardAuthor(row, data.fallbackAgentId);
      if (filters.ownerIds.length > 0 && !filters.ownerIds.includes(author.id)) {
        return false;
      }
      return (
        !query ||
        [
          resolveSessionDisplayName(row.key, row),
          author.label,
          row.lastMessagePreview,
          row.key,
        ].some((value) => value?.toLocaleLowerCase().normalize("NFC").includes(query))
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
      // Let CSS size the first rows before assigning measured virtual tracks.
      return props.rows.slice(0, 12);
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
      if (!windowed() || view().tracks.length === 0) {
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
        <DashboardEntry
          variant="card"
          data={props.data}
          row={card.row}
          handlers={props.handlers}
          gatewaySnapshot={props.gatewaySnapshot}
          contentRef={bindContent}
        />
      </div>
    );
  }
  return (
    <div
      ref={(element) => (grid = element)}
      class="dashboards-grid"
      role="list"
      style={
        windowed() && view().tracks.length > 0
          ? {
              position: "relative",
              height: `${view().height}px`,
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
  const authors = createMemo(() => dashboardAuthors(props.data));
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
          <DashboardAuthorChip
            authors={authors()}
            selfId={props.gatewaySnapshot?.selfUser?.id}
            filters={props.filters}
            handlers={props.handlers}
          />
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
            <For
              each={dashboardGroups(
                props.data,
                visibleRows(),
                props.filters.group,
                props.gatewaySnapshot?.selfUser?.id,
              )}
              keyed={(group) => group.key}
            >
              {(group) => (
                <section class="dashboards-group">
                  <Show when={group().label}>
                    <h3 class="dashboards-group__heading">{group().label}</h3>
                  </Show>
                  <Show
                    when={props.filters.view === "list"}
                    fallback={
                      <DashboardGrid
                        data={props.data}
                        rows={group().rows}
                        handlers={props.handlers}
                        gatewaySnapshot={props.gatewaySnapshot}
                      />
                    }
                  >
                    <div class="dashboards-list" role="list">
                      <For each={group().rows} keyed={(row) => row.key}>
                        {(row) => (
                          <div role="listitem">
                            <DashboardEntry
                              variant="row"
                              data={props.data}
                              row={row()}
                              handlers={props.handlers}
                              gatewaySnapshot={props.gatewaySnapshot}
                            />
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>
                </section>
              )}
            </For>
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
        <div class="dashboards-grid">
          <For each={[0, 1, 2, 3, 4, 5]}>
            {() => (
              <div class="dashboard-card">
                <div class="dashboard-card__main">
                  <div class="dashboard-preview skeleton" />
                  <div class="dashboard-card__body">
                    <div class="dashboard-card__heading">
                      <div class="skeleton skeleton-line skeleton-line--long dashboards-loading__title" />
                    </div>
                    <div class="dashboard-card__meta">
                      <div class="skeleton skeleton-line skeleton-line--medium" />
                    </div>
                  </div>
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
          <Show when={props.data?.result?.sessions.length ? props.data : undefined}>
            {(data) => (
              <div class="dashboards-tools">
                <DashboardSearch
                  query={props.filters.query}
                  onQueryChange={(query) => props.handlers.onFilterChange({ query })}
                />
                <DashboardAuthorFilter
                  authors={dashboardAuthors(data())}
                  selfId={props.gatewaySnapshot?.selfUser?.id}
                  filters={props.filters}
                  handlers={props.handlers}
                />
                <DashboardDisplayMenu filters={props.filters} handlers={props.handlers} />
              </div>
            )}
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
