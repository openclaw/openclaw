import type { JSX } from "@solidjs/web";
import { createMemo, For, Show } from "solid-js";
import type { GatewayControlUiPluginTab } from "../api/gateway.ts";
import {
  parseSidebarEntry,
  serializeSidebarEntry,
  SIDEBAR_NAV_ROUTES,
  titleForRoute,
  USERS_SECTION_PLUGIN_PAGES,
  type SidebarZoneEntry,
} from "../app-navigation.ts";
import { t } from "../lib/reactive/i18n.ts";
import { nativeListener } from "../lib/solid-native-listener.ts";
import {
  isNavigationSectionChild,
  navigationSectionChildren,
  navigationSectionForPage,
} from "../plugins/navigation-sections.ts";
import { renderAppSidebarPluginTab, type AppSidebarRenderHost } from "./app-sidebar-render.tsx";
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
        // A plugin's child items (Workboard's boards) live in its own sidebar, not here.
        ...props.host
          .pluginNavigation()
          .filter((entry, _, all) => !isNavigationSectionChild(all, entry))
          .map((entry) => entry.key),
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

/**
 * A plugin page whose navigation item has children, such as Workboard and its boards: the
 * item itself, then each child, each with its pin toggle so a child can sit on the rail.
 */
export function SidebarPluginSection(props: { host: AppSidebarRenderHost }): JSX.Element {
  const section = createMemo(() =>
    navigationSectionForPage(props.host.pluginNavigation(), props.host.activePluginTabId),
  );
  const keys = createMemo(() => {
    const parent = section();
    return parent
      ? [parent, ...navigationSectionChildren(props.host.pluginNavigation(), parent)].map((entry) =>
          serializeSidebarEntry({ type: "plugin", key: entry.key }),
        )
      : [];
  });
  const zone = createMemo(() => props.host.reconciledSidebarZone());
  return (
    <nav class="sidebar-pages sidebar-plugin-section" aria-label={section()?.value.label}>
      <For each={keys()}>
        {(key) => (
          <div class="sidebar-pages__entry">
            {renderAppSidebarPageEntry(
              props.host,
              parseSidebarEntry(key)!,
              () => zone().pluginTabs,
            )}
            <PinToggle host={props.host} entry={key} />
          </div>
        )}
      </For>
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
