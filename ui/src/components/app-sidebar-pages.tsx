import type { JSX } from "@solidjs/web";
import { createMemo, For, Show } from "solid-js";
import type { GatewayControlUiPluginTab } from "../api/gateway.ts";
import {
  parseSidebarEntry,
  serializeSidebarEntry,
  SIDEBAR_NAV_ROUTES,
  titleForRoute,
  type SidebarZoneEntry,
} from "../app-navigation.ts";
import { beginNativeWindowDrag } from "../app/native-window-drag.ts";
import { t } from "../lib/reactive/i18n.ts";
import { renderAppSidebarPluginTab, type AppSidebarRenderHost } from "./app-sidebar-render.tsx";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";
import { McpAppCatalog } from "./mcp-app-catalog.tsx";
import { SidebarCollapseToggle } from "./sidebar-collapse-toggle.tsx";
import { restoreSnapshotSession } from "./sidebar-snapshot-model.ts";
import { Icon } from "./solid/icon.tsx";

/** Pages is the accessible destination catalog, not another favorites list. */
export function SidebarPages(props: { host: AppSidebarRenderHost }): JSX.Element {
  const zone = createMemo(() => props.host.reconciledSidebarZone());
  const dashboards = () => props.host.navigationCatalog.dashboards;
  const dashboardRows = createMemo(() =>
    props.host.sidebarSnapshot
      ? props.host.sidebarSnapshot.pages
          .filter((row) => !row.archived)
          .map((row) => restoreSnapshotSession(row, props.host.getRouteSessionKey()))
      : (dashboards()?.result?.sessions ?? []).map((row) =>
          props.host.getSessionNavigationState().toSidebarSession(row),
        ),
  );
  const rows = createMemo(() => {
    const result = new Map(zone().sessionRows);
    for (const row of dashboardRows()) {
      result.set(row.key, row);
    }
    return result;
  });
  const entries = createMemo(() => {
    const result = SIDEBAR_NAV_ROUTES.filter((route) =>
      props.host.sidebarMenus.isRouteEnabled(route),
    )
      .toSorted((left, right) => titleForRoute(left).localeCompare(titleForRoute(right)))
      .map((route) => serializeSidebarEntry({ type: "route", route }));
    for (const key of new Set([
      ...zone().pluginTabs.keys(),
      ...props.host.pluginNavigation().map((entry) => entry.key),
    ])) {
      result.push(serializeSidebarEntry({ type: "plugin", key }));
    }
    for (const row of dashboardRows()) {
      result.push(serializeSidebarEntry({ type: "session", key: row.key }));
    }
    return result;
  });
  return (
    <nav
      class="sidebar-pages"
      aria-label={t("nav.pages")}
      onDragOver={(event) => props.host.sessionOrganizer.handleSessionListDragOver(event)}
      onDrop={(event) => props.host.sessionOrganizer.handleSessionListDrop(event)}
    >
      <div class="sidebar-pages__heading sidebar-panel-header" onMouseDown={beginNativeWindowDrag}>
        <span>{t("nav.pages")}</span>
        <SidebarCollapseToggle onToggle={() => props.host.onToggleSidebar?.()} />
      </div>
      <McpAppCatalog surface="sidebar" />
      <For each={entries()}>
        {(key) => {
          // Allocate once per entry; the rendered link owns its reactive fields.
          const content = renderAppSidebarPageEntry(
            props.host,
            parseSidebarEntry(key)!,
            rows,
            () => zone().pluginTabs,
          );
          return (
            <div class="sidebar-pages__entry">
              {content}
              <button
                type="button"
                class={[
                  "sidebar-pages__pin",
                  { "sidebar-pages__pin--pinned": props.host.sidebarEntries.includes(key) },
                ]}
                disabled={Boolean(props.host.sidebarSnapshot)}
                aria-label={t(props.host.sidebarEntries.includes(key) ? "nav.unpin" : "nav.pin")}
                onClick={() => {
                  if (props.host.sidebarEntries.includes(key)) {
                    props.host.sessionOrganizer.removeSidebarEntry(key);
                  } else {
                    props.host.sessionOrganizer.writeSidebarEntryAt(key, undefined, undefined);
                  }
                }}
              >
                <Icon name="pin" />
              </button>
            </div>
          );
        }}
      </For>
      <Show when={dashboards()?.error}>{(error) => <span role="alert">{error()}</span>}</Show>
      <Show when={dashboards()?.result?.hasMore}>
        <button
          type="button"
          class="btn btn--sm"
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
  sessionRows: () => ReadonlyMap<string, SidebarRecentSession>,
  pluginTabs: () => ReadonlyMap<string, GatewayControlUiPluginTab>,
): JSX.Element {
  if (entry.type === "person") {
    return undefined;
  }
  const serialized = serializeSidebarEntry(entry);
  const pluginTab = () => (entry.type === "plugin" ? pluginTabs().get(entry.key) : undefined);
  const pinnedSession = () => (entry.type === "session" ? sessionRows().get(entry.key) : undefined);
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
    ) : (
      <Show when={pinnedSession()}>{(session) => host.renderPinnedSidebarSession(session)}</Show>
    );
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
