import type { JSX } from "@solidjs/web";
import { createMemo, createSignal, For, Show } from "solid-js";
import type { GatewayControlUiPluginTab } from "../api/gateway.ts";
import {
  parseSidebarEntry,
  serializeSidebarEntry,
  SIDEBAR_NAV_ROUTES,
  titleForRoute,
  USERS_SECTION_PLUGIN_PAGES,
  type SidebarZoneEntry,
} from "../app-navigation.ts";
import {
  DASHBOARD_UPDATED_GROUP_LABELS,
  dashboardAuthor,
  dashboardsFilter,
  dashboardUpdatedGroup,
} from "../lib/dashboards-filter.ts";
import { useApplication } from "../lib/reactive/context.ts";
import { formatRelativeTimestamp } from "../lib/reactive/format.ts";
import { t } from "../lib/reactive/i18n.ts";
import { rememberSectionLocation } from "../lib/section-navigation.ts";
import { resolveSessionDisplayName } from "../lib/session-display.ts";
import {
  resolveSessionNavigationAgentId,
  resolveSessionPreferredFace,
} from "../lib/sessions/route-navigation.ts";
import { nativeListener } from "../lib/solid-native-listener.ts";
import { renderAppSidebarPluginTab, type AppSidebarRenderHost } from "./app-sidebar-render.tsx";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";
import { SidebarListGroup } from "./sidebar-list-group.tsx";
import { restoreSnapshotSession } from "./sidebar-snapshot-model.ts";
import { Icon } from "./solid/icon.tsx";

function PinToggle(props: { host: AppSidebarRenderHost; entry: string }) {
  const pinned = () => props.host.sidebarEntries.includes(props.entry);
  return (
    <button
      type="button"
      class={["sidebar-pages__pin", { "sidebar-pages__pin--pinned": pinned() }]}
      disabled={Boolean(props.host.sidebarSnapshot)}
      aria-label={t(pinned() ? "nav.unpin" : "nav.pin")}
      onClick={(event) => {
        // Pinning keeps the surrounding menu open.
        event.stopPropagation();
        if (pinned()) {
          props.host.sessionOrganizer.removeSidebarEntry(props.entry);
        } else {
          props.host.sessionOrganizer.writeSidebarEntryAt(props.entry, undefined, undefined);
        }
      }}
    >
      <Icon name="pin" />
    </button>
  );
}

/**
 * The rail's "more" menu: every native page, a separator, then every plugin page,
 * each with its pin toggle. Sessions, people and agents have their own sections.
 */
export function SidebarPagesMenu(props: {
  host: AppSidebarRenderHost;
  onNavigate: (entry: SidebarZoneEntry | null) => void;
}): JSX.Element {
  const zone = createMemo(() => props.host.reconciledSidebarZone());
  const routes = createMemo(() =>
    // Sessions opens from the agent avatar and its groups, so the menu leaves it out.
    SIDEBAR_NAV_ROUTES.filter(
      (route) => route !== "sessions" && props.host.sidebarMenus.isRouteEnabled(route),
    )
      .toSorted((left, right) => titleForRoute(left, t).localeCompare(titleForRoute(right, t)))
      .map((route) => serializeSidebarEntry({ type: "route", route })),
  );
  const plugins = createMemo(() =>
    [
      ...new Set([
        ...zone().pluginTabs.keys(),
        ...props.host.pluginNavigation().map((entry) => entry.key),
      ]),
    ]
      // The Users section lists its plugin pages itself.
      .filter((key) => !USERS_SECTION_PLUGIN_PAGES.has(key))
      .map((key) => serializeSidebarEntry({ type: "plugin", key })),
  );
  const Entry = (entry: { key: string }) => {
    // Allocate once per entry; the rendered link owns its reactive fields.
    const content = renderAppSidebarPageEntry(
      props.host,
      parseSidebarEntry(entry.key)!,
      () => zone().pluginTabs,
    );
    return (
      <div class="sidebar-pages__entry">
        {content}
        <PinToggle host={props.host} entry={entry.key} />
      </div>
    );
  };
  return (
    <nav
      class="sidebar-pages sidebar-pages-menu"
      aria-label={t("nav.pages")}
      // Plugin links render in their own root, which delegated handlers do not see.
      ref={nativeListener(
        "click",
        (event: MouseEvent) => {
          const path = event.composedPath();
          if (
            event.button !== 0 ||
            event.metaKey ||
            event.ctrlKey ||
            event.shiftKey ||
            event.altKey ||
            !path.some((target) => target instanceof Element && target.matches("a[href]"))
          ) {
            return;
          }
          const row = path.find(
            (target): target is Element =>
              target instanceof Element && target.hasAttribute("data-sidebar-entry"),
          );
          props.onNavigate(row ? parseSidebarEntry(row.getAttribute("data-sidebar-entry")) : null);
        },
        true,
      )}
    >
      <For each={routes()}>{(key) => <Entry key={key} />}</For>
      <Show when={plugins().length > 0}>
        <span class="sidebar-pages-menu__separator" aria-hidden="true" />
        <For each={plugins()}>{(key) => <Entry key={key} />}</For>
      </Show>
    </nav>
  );
}

/** The Dashboards section: every managed dashboard, newest first, with its author and update. */
export function SidebarDashboards(props: { host: AppSidebarRenderHost }): JSX.Element {
  const app = useApplication();
  const dashboards = () => props.host.navigationCatalog.dashboards;
  // The header's filter narrows to one author and orders the loaded rows.
  const filteredDashboards = createMemo(() => {
    const filter = dashboardsFilter();
    const fallbackAgentId = resolveSessionNavigationAgentId(app);
    const agents = app.agents.state.agentsList?.agents ?? [];
    const rows = (dashboards()?.result?.sessions ?? []).filter(
      (row) =>
        !filter.authorId || dashboardAuthor(row, fallbackAgentId, agents).id === filter.authorId,
    );
    return filter.sort === "title"
      ? rows.toSorted((left, right) =>
          resolveSessionDisplayName(left.key, left).localeCompare(
            resolveSessionDisplayName(right.key, right),
          ),
        )
      : rows;
  });
  const dashboardRows = createMemo(() =>
    props.host.sidebarSnapshot
      ? props.host.sidebarSnapshot.pages
          .filter((row) => !row.archived)
          .map((row) => restoreSnapshotSession(row, props.host.getRouteSessionKey()))
      : filteredDashboards().map((row) =>
          props.host.getSessionNavigationState().toSidebarSession(row),
        ),
  );
  // The author the filter offers, read the same way: whoever created the dashboard's session.
  const authors = createMemo(() => {
    const fallbackAgentId = resolveSessionNavigationAgentId(app);
    const agents = app.agents.state.agentsList?.agents ?? [];
    return new Map(
      filteredDashboards().map((row) => [row.key, dashboardAuthor(row, fallbackAgentId, agents)]),
    );
  });
  // The header's grouping, as the gallery groups: by when each was updated, or by author.
  const groups = createMemo(() => {
    const group = dashboardsFilter().group;
    if (group === "none") {
      return undefined;
    }
    const selfId = app.gateway.snapshot.selfUser?.id;
    const byKey = new Map<string, { key: string; label: string; rows: SidebarRecentSession[] }>();
    for (const row of dashboardRows()) {
      const author = authors().get(row.key);
      const bucket = group === "updated" ? dashboardUpdatedGroup(row.updatedAt ?? undefined) : null;
      const key = bucket ?? author?.id ?? "";
      const label = bucket
        ? t(DASHBOARD_UPDATED_GROUP_LABELS[bucket])
        : author?.id === selfId
          ? t("dashboardsPage.you")
          : (author?.label ?? "");
      const known = byKey.get(key);
      if (known) {
        known.rows.push(row);
      } else {
        byKey.set(key, { key, label, rows: [row] });
      }
    }
    const entries = [...byKey.values()];
    // Dates read newest first whatever the order; authors keep the order of their first row.
    return group === "updated"
      ? entries.toSorted(
          (left, right) =>
            Object.keys(DASHBOARD_UPDATED_GROUP_LABELS).indexOf(left.key) -
            Object.keys(DASHBOARD_UPDATED_GROUP_LABELS).indexOf(right.key),
        )
      : entries;
  });
  const [closedGroups, setClosedGroups] = createSignal<ReadonlySet<string>>(new Set());
  const byline = (row: SidebarRecentSession) => {
    // A row grouped by its author leaves the author to the group heading.
    const author =
      dashboardsFilter().group === "author" ? undefined : authors().get(row.key)?.label;
    const updated = row.updatedAt ? formatRelativeTimestamp(row.updatedAt) : undefined;
    return [author, updated].filter(Boolean).join(" · ") || undefined;
  };
  const Row = (entry: { row: SidebarRecentSession }) => {
    const row = entry.row;
    const key = serializeSidebarEntry({ type: "session", key: row.key });
    // Allocate once per row; the session row owns its reactive fields.
    const content = props.host.renderPinnedSidebarSession(
      () => row,
      () => byline(row),
    );
    return (
      <div class="sidebar-pages__entry">
        <div
          class="sidebar-zone-entry"
          data-sidebar-entry={key}
          // Remember where the row went, so returning to Dashboards in this tab reopens it.
          onClick={(event) => {
            const link = event
              .composedPath()
              .find((target): target is HTMLAnchorElement => target instanceof HTMLAnchorElement);
            // The row handles the click first, so only plain clicks count here.
            const plain =
              event.button === 0 &&
              !event.metaKey &&
              !event.ctrlKey &&
              !event.shiftKey &&
              !event.altKey;
            if (link && plain) {
              const url = new URL(link.href);
              rememberSectionLocation(app.gateway, "dashboards", {
                route: resolveSessionPreferredFace(row),
                options: { pathname: url.pathname, search: url.search },
              });
            }
          }}
        >
          {content}
        </div>
        <PinToggle host={props.host} entry={key} />
      </div>
    );
  };
  return (
    <nav
      class="sidebar-dashboards"
      aria-label={titleForRoute("dashboards", t)}
      onDragOver={(event) => props.host.sessionOrganizer.handleSessionListDragOver(event)}
      onDrop={(event) => props.host.sessionOrganizer.handleSessionListDrop(event)}
    >
      <Show
        when={groups()}
        fallback={<For each={dashboardRows()}>{(row) => <Row row={row} />}</For>}
      >
        {(list) => (
          <For each={list()}>
            {(group) => (
              <SidebarListGroup
                label={group.label}
                open={!closedGroups().has(group.key)}
                onToggle={() =>
                  setClosedGroups((closed) =>
                    closed.has(group.key)
                      ? new Set([...closed].filter((key) => key !== group.key))
                      : new Set([...closed, group.key]),
                  )
                }
              >
                <For each={group.rows}>{(row) => <Row row={row} />}</For>
              </SidebarListGroup>
            )}
          </For>
        )}
      </Show>
      <Show when={dashboards()?.error}>{(error) => <span role="alert">{error()}</span>}</Show>
      <Show when={dashboards()?.result?.hasMore}>
        <button
          type="button"
          class="sidebar-dashboards__more"
          onClick={() => props.host.navigationCatalog.loadMoreDashboards()}
        >
          {t("chat.selectors.loadMoreSessions")}
        </button>
      </Show>
    </nav>
  );
}

function renderAppSidebarPageEntry(
  host: AppSidebarRenderHost,
  entry: SidebarZoneEntry,
  pluginTabs: () => ReadonlyMap<string, GatewayControlUiPluginTab>,
): JSX.Element {
  if (entry.type === "person" || entry.type === "session") {
    return undefined;
  }
  const serialized = serializeSidebarEntry(entry);
  const pluginTab = () => (entry.type === "plugin" ? pluginTabs().get(entry.key) : undefined);
  const content =
    entry.type === "route" ? (
      host.sidebarMenus.renderRoute(entry.route, host)
    ) : entry.type === "plugin" ? (
      <Show
        when={pluginTab()}
        fallback={
          <openclaw-plugin-contributions
            prop:kind={"navigation"}
            prop:navigationKey={entry.key}
            prop:navigationChildren={false}
            prop:navigationMenus={host.sidebarMenus}
          />
        }
      >
        {(tab) => renderAppSidebarPluginTab(host, tab)}
      </Show>
    ) : undefined;
  const draggable = () =>
    !host.sidebarSnapshot && (entry.type === "route" || entry.type === "plugin");
  return (
    <div
      class={[
        "sidebar-zone-entry",
        {
          "sidebar-zone-entry--dragging": host.sessionOrganizer.draggingSidebarEntry === serialized,
        },
      ]}
      data-sidebar-entry={serialized}
      draggable={draggable() ? "true" : "false"}
      onDragStart={
        entry.type === "route"
          ? (event: DragEvent) => host.sessionOrganizer.startSidebarRouteDrag(event, entry.route)
          : entry.type === "plugin"
            ? (event: DragEvent) => host.sessionOrganizer.startSidebarPluginDrag(event, entry.key)
            : undefined
      }
      onDragEnd={() => {
        if (draggable()) {
          host.sessionOrganizer.finishSidebarEntryDrag();
        }
      }}
    >
      {content}
    </div>
  );
}
