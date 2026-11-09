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
import type {
  DashboardGalleryFilters,
  DashboardGalleryHandlers,
  DashboardsRouteData,
} from "./gallery-filters.ts";

registerDashboardsEnglish();

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

function DashboardGrid(props: {
  data: DashboardsRouteData;
  groups: ReturnType<typeof dashboardGroups>;
  view: DashboardGalleryFilters["view"];
  handlers: DashboardGalleryHandlers;
  gatewaySnapshot?: ApplicationGatewaySnapshot;
}) {
  let gallery!: HTMLDivElement;
  let scroller: HTMLElement | null = null;
  const grids = new Map<string, HTMLDivElement>();
  const headings = new Map<string, HTMLHeadingElement>();
  const content = new Map<string, HTMLElement>();
  const [focused, setFocused] = createSignal<string>();
  const [metrics, setMetrics] = createSignal({ columns: 3, gap: 16, groupGap: 24 });
  const [view, setView] = createSignal<{
    tracks: VirtualItem[];
    measurements: VirtualItem[];
    height: number;
    available: boolean;
  }>({ tracks: [], measurements: [], height: 0, available: true });
  const rowCount = createMemo(() =>
    props.groups.reduce((count, group) => count + group.rows.length, 0),
  );
  const windowed = createMemo(() => rowCount() > 60 && view().available);
  const layout = createMemo(() => {
    const tracks: Array<{
      key: string;
      heading: boolean;
      gap: number;
    }> = [];
    const rowTracks: number[] = [];
    const indexes = new Map<string, { track: number; column: number; position: number }>();
    let position = 0;
    const groups = props.groups.map((group, groupIndex) => {
      const start = tracks.length;
      if (group.label) {
        tracks.push({
          key: `heading:${group.key}`,
          heading: true,
          gap: groupIndex > 0 ? metrics().groupGap : 0,
        });
      }
      const bodyStart = tracks.length;
      for (let index = 0; index < group.rows.length; index += metrics().columns) {
        const rows = group.rows.slice(index, index + metrics().columns);
        const track = tracks.length;
        rowTracks.push(track);
        for (const [column, row] of rows.entries()) {
          indexes.set(row.key, { track, column, position: position++ });
        }
        tracks.push({
          key: `${props.view}:${metrics().columns}:${group.key}:${rows[0]!.key}`,
          heading: false,
          gap: index + metrics().columns < group.rows.length ? metrics().gap : 0,
        });
      }
      return { ...group, start, bodyStart, end: tracks.length - 1, groupIndex };
    });
    return {
      tracks,
      rowTracks,
      indexes,
      groups,
      getItemKey: (index: number) => tracks[index]!.key,
    };
  });
  // Pin endpoints and neighboring dashboard tracks globally, including across group headings.
  const pinned = () => {
    const { rowTracks, indexes } = layout();
    const result = new Set<number>([rowTracks[0]!, rowTracks.at(-1)!]);
    const track = indexes.get(focused() ?? "")?.track;
    if (track !== undefined) {
      const index = rowTracks.indexOf(track);
      for (const neighbor of rowTracks.slice(Math.max(0, index - 1), index + 2)) {
        result.add(neighbor);
      }
    }
    return result;
  };
  const publish = () => {
    const tracks = virtualizer.getVirtualItems();
    const measurements = virtualizer.measurementsCache;
    const height = virtualizer.getTotalSize();
    setView((previous) =>
      previous.height === height &&
      previous.measurements === measurements &&
      previous.available === Boolean(scroller) &&
      previous.tracks.length === tracks.length &&
      previous.tracks.every((track, index) => {
        const next = tracks[index]!;
        return track.index === next.index && track.start === next.start && track.size === next.size;
      })
        ? previous
        : { tracks, measurements, height, available: Boolean(scroller) },
    );
  };
  const virtualizer = new Virtualizer<HTMLElement, HTMLDivElement>({
    count: 0,
    enabled: false,
    getScrollElement: () => scroller,
    estimateSize: (index) => {
      const track = layout().tracks[index]!;
      return (track.heading ? 30 : props.view === "list" ? 64 : 320) + track.gap;
    },
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
    () => ({
      layout: layout(),
      view: props.view,
      focused: focused(),
      windowed: windowed(),
      metrics: metrics(),
    }),
    (next) => {
      const firstGrid = grids.values().next().value;
      if (!next || !firstGrid) {
        return undefined;
      }
      const viewport = gallery.closest<HTMLElement>(".content");
      const style = getComputedStyle(firstGrid);
      const nextColumns =
        next.view === "list" ? 1 : style.gridTemplateColumns.split(" ").filter(Boolean).length || 3;
      const nextGap = Number.parseFloat(style.rowGap) || 0;
      const groupGap = Number.parseFloat(style.getPropertyValue("--space-6")) || 24;
      if (
        nextColumns !== next.metrics.columns ||
        nextGap !== next.metrics.gap ||
        groupGap !== next.metrics.groupGap
      ) {
        return () => setMetrics({ columns: nextColumns, gap: nextGap, groupGap });
      }
      const margin = viewport
        ? gallery.getBoundingClientRect().top -
          viewport.getBoundingClientRect().top +
          viewport.scrollTop
        : 0;
      const heights = new Map<number, number>();
      for (const group of next.layout.groups) {
        const heading = headings.get(group.key);
        if (heading) {
          const headingStyle = getComputedStyle(heading);
          heights.set(
            group.start,
            heading.getBoundingClientRect().height +
              (Number.parseFloat(headingStyle.marginTop) || 0) +
              (Number.parseFloat(headingStyle.marginBottom) || 0) +
              next.layout.tracks[group.start]!.gap,
          );
        }
      }
      for (const [key, element] of content) {
        const index = next.layout.indexes.get(key);
        if (index) {
          // Measure intrinsic content so resizing can shrink a track as well as grow it.
          const height =
            element.getBoundingClientRect().height +
            (next.view === "grid" ? 2 : 0) +
            next.layout.tracks[index.track]!.gap;
          heights.set(index.track, Math.max(heights.get(index.track) ?? 0, height));
        }
      }
      const staticPinnedTracks = pinned();
      return () => {
        scroller = viewport;
        virtualizer.setOptions({
          ...virtualizer.options,
          count: next.layout.tracks.length,
          enabled: next.windowed && Boolean(viewport),
          getItemKey: next.layout.getItemKey,
          gap: 0,
          scrollMargin: margin,
          rangeExtractor: (range) =>
            [...new Set([...defaultRangeExtractor(range), ...staticPinnedTracks])].toSorted(
              (a, b) => a - b,
            ),
        });
        const { _willUpdate: updateVirtualizer } = virtualizer;
        updateVirtualizer();
        for (const [index, height] of heights) {
          if (height > 0) {
            virtualizer.resizeItem(index, height);
          }
        }
        publish();
      };
    },
    {
      targets: () => [
        gallery,
        ...(scroller ? [scroller] : []),
        ...grids.values(),
        ...headings.values(),
        ...content.values(),
      ],
      fonts: true,
    },
  );
  const positioned = () => windowed() && view().measurements.length > 0;
  const visible = createMemo(() => {
    if (!windowed()) {
      return layout().groups;
    }
    const selected = new Set(
      view().tracks.length > 0
        ? [...view().tracks.map((track) => track.index), ...pinned()]
        : layout()
            .tracks.slice(0, 12)
            .map((_, index) => index),
    );
    return layout().groups.flatMap((group) => {
      const rows = group.rows.filter((row) => selected.has(layout().indexes.get(row.key)!.track));
      return rows.length > 0 || selected.has(group.start) ? [{ ...group, rows }] : [];
    });
  });
  function CardSlot(card: { row: DashboardRow; bodyStart: number }) {
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
    const index = () => layout().indexes.get(card.row.key)!;
    const position = (): JSX.CSSProperties | undefined => {
      const track = view().measurements[index().track];
      const first = view().measurements[card.bodyStart];
      if (!positioned() || !track || !first) {
        return undefined;
      }
      return {
        position: "absolute",
        top: `${track.start - first.start}px`,
        "inset-inline-start": `calc(${index().column} * (100% + ${metrics().gap}px) / ${metrics().columns})`,
        width: `calc((100% - ${(metrics().columns - 1) * metrics().gap}px) / ${metrics().columns})`,
        height: `${track.size - layout().tracks[index().track]!.gap}px`,
      };
    };
    return (
      <div
        class="dashboards-grid__item"
        role="listitem"
        aria-posinset={index().position + 1}
        aria-setsize={rowCount()}
        style={position()}
        onFocusIn={() => setFocused(card.row.key)}
      >
        <DashboardEntry
          variant={props.view === "list" ? "row" : "card"}
          data={props.data}
          row={card.row}
          handlers={props.handlers}
          gatewaySnapshot={props.gatewaySnapshot}
          contentRef={bindContent}
        />
      </div>
    );
  }
  function Group(groupProps: { group: ReturnType<typeof visible>[number] }) {
    let grid: HTMLDivElement;
    let heading: HTMLHeadingElement;
    const group = () => groupProps.group;
    onSettled(() => {
      const staticKey = group().key;
      grids.set(staticKey, grid);
      if (heading) {
        headings.set(staticKey, heading);
      }
      measure();
      return () => {
        grids.delete(staticKey);
        headings.delete(staticKey);
        measure();
      };
    });
    const sectionPosition = (): JSX.CSSProperties | undefined => {
      const first = view().measurements[group().start];
      if (!positioned() || !first) {
        return undefined;
      }
      return {
        position: "absolute",
        top: `${first.start - virtualizer.options.scrollMargin}px`,
        width: "100%",
        "margin-top": "0",
        "padding-top": `${group().label && group().groupIndex > 0 ? metrics().groupGap : 0}px`,
      };
    };
    const gridPosition = (): JSX.CSSProperties | undefined => {
      const first = view().measurements[group().bodyStart];
      const last = view().measurements[group().end];
      if (!positioned() || !first || !last) {
        return undefined;
      }
      return { position: "relative", height: `${last.end - first.start}px` };
    };
    return (
      <section class="dashboards-group" style={sectionPosition()}>
        <Show when={group().label}>
          <h3 ref={(element) => (heading = element)} class="dashboards-group__heading">
            {group().label}
          </h3>
        </Show>
        <div
          ref={(element) => (grid = element)}
          class={props.view === "list" ? "dashboards-list" : "dashboards-grid"}
          role="list"
          style={gridPosition()}
        >
          <For each={group().rows} keyed={(row) => row.key}>
            {(row) => <CardSlot row={row()} bodyStart={group().bodyStart} />}
          </For>
        </div>
      </section>
    );
  }
  return (
    <div
      ref={(element) => (gallery = element)}
      style={positioned() ? { position: "relative", height: `${view().height}px` } : undefined}
    >
      <For each={visible()} keyed={(group) => group.key}>
        {(group) => <Group group={group()} />}
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
            <DashboardGrid
              data={props.data}
              groups={dashboardGroups(
                props.data,
                visibleRows(),
                props.filters.group,
                props.gatewaySnapshot?.selfUser?.id,
              )}
              view={props.filters.view}
              handlers={props.handlers}
              gatewaySnapshot={props.gatewaySnapshot}
            />
          </Show>
        </section>
      </Show>
    </Show>
  );
}

function DashboardGallerySkeleton(props: { view: DashboardGalleryFilters["view"] }) {
  return (
    <section class="dashboards-gallery" aria-busy="true">
      <span class="sr-only" role="status">
        {t("common.loading")}
      </span>
      <div class="dashboards-loading" aria-hidden="true" inert>
        <Show
          when={props.view === "list"}
          fallback={
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
          }
        >
          <div class="dashboards-list">
            <For each={[0, 1, 2, 3, 4, 5]}>
              {() => (
                <div class="dashboard-row">
                  <div class="dashboard-row__main">
                    <div class="dashboard-row__thumb skeleton" />
                    <div class="dashboard-row__title">
                      <div class="skeleton skeleton-line skeleton-line--long" />
                    </div>
                    <div class="dashboard-row__author skeleton skeleton-line skeleton-line--medium" />
                    <div class="dashboard-row__updated skeleton skeleton-line skeleton-line--medium" />
                  </div>
                </div>
              )}
            </For>
          </div>
        </Show>
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
          fallback={<DashboardGallerySkeleton view={props.filters.view} />}
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
            <DashboardGallerySkeleton view={props.filters.view} />
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
