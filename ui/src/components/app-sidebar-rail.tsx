import type { JSX } from "@solidjs/web";
import { createMemo, createSignal, For, lazy, Show, onSettled } from "solid-js";
import {
  SESSION_ICON_GLYPH_IDS,
  SESSION_ICON_SVG_DATA_URL_PREFIX,
} from "../../../packages/gateway-protocol/src/session-agent-status.ts";
import {
  isRailSectionPin,
  isSettingsTakeover,
  normalizeSidebarEntries,
  sidebarSectionForRoute,
  parseSidebarEntry,
  serializeSidebarEntry,
  titleForRoute,
  type SidebarZoneEntry,
} from "../app-navigation.ts";
import { isMobileNavLayout } from "../app/mobile-nav-layout.ts";
import { beginNativeWindowDragFromTopInset } from "../app/native-window-drag.ts";
import { handleContextMenuEvent } from "../lib/keyboard-shortcuts.ts";
import { handleNavigationClick } from "../lib/navigation-click.ts";
import { projectOnlinePresenceViewers, presenceViewerLabel } from "../lib/presence-users.ts";
import { elementRef } from "../lib/reactive/element-ref.ts";
import { t } from "../lib/reactive/i18n.ts";
import { nativeListener } from "../lib/solid-native-listener.ts";
import { isSidebarRouteActive } from "./app-sidebar-nav-menus.tsx";
import {
  renderSidebarAgentCard,
  renderAppSidebarFooterBar,
  renderAppSidebarPluginTab,
  type AppSidebarRenderHost,
} from "./app-sidebar-render.tsx";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";
import { personActivityLink, personActivityRouting } from "./person-activity-link.ts";
import { SessionIconGraphic } from "./session-icon-glyph-solid.tsx";
import { SidebarViewBoundary } from "./sidebar-view-boundary.tsx";
import { Icon } from "./solid/icon.tsx";
import { Popover, type PopoverHandle } from "./solid/popover.tsx";
import { SessionOwnerAvatar } from "./solid/session-owner-chip.tsx";
import { SessionGlyph, renderSessionUnreadBadge } from "./solid/session-presentation.tsx";

type SidebarZone = ReturnType<AppSidebarRenderHost["reconciledSidebarZone"]>;
type RailPinTouchPress = {
  pointerId: number;
  x: number;
  y: number;
  timer?: ReturnType<typeof setTimeout>;
  opened: boolean;
};

const SidebarPagesMenu = lazy(() => import("./app-sidebar-pages.tsx"), {
  export: "SidebarPagesMenu",
});

/**
 * After a rail or menu destination is chosen: a section page opens its own sidebar
 * (clicking the open section's item closes it); any other page runs full width.
 */
function revealDestination(host: AppSidebarRenderHost, entry: SidebarZoneEntry) {
  if (host.onExitSettings) {
    return;
  }
  const section = entry.type === "route" ? sidebarSectionForRoute(entry.route) : undefined;
  if (isMobileNavLayout()) {
    // The drawer closes on navigation and shows this section's list when it opens again.
    if (section) {
      host.navigationView = section;
      host.invalidate();
    }
    return;
  }
  if (!section) {
    if (!host.navigationCollapsed) {
      host.onToggleSidebar?.();
    }
    return;
  }
  const current = host.navigationView === section && !host.navigationCollapsed;
  host.navigationView = section;
  if (current || host.navigationCollapsed) {
    host.onToggleSidebar?.();
  }
  host.invalidate();
}

export function renderSidebarRail(host: AppSidebarRenderHost): JSX.Element {
  const zone = createMemo(() => host.reconciledSidebarZone());
  const pins = createMemo(() =>
    (normalizeSidebarEntries(host.sidebarSnapshot?.entries ?? host.sidebarEntries) ?? []).filter(
      (entry) => !entry.startsWith("session:"),
    ),
  );
  // Saved order is kept; the rail shows native sections first, then everything else.
  const sectionPins = createMemo(() => pins().filter(isRailSectionPin));
  const otherPins = createMemo(() => pins().filter((entry) => !isRailSectionPin(entry)));
  // The agent avatar above is the Sessions item; "more" below the sections opens a page menu.
  const peoplePressed = () =>
    host.navigationVisible &&
    !host.onExitSettings &&
    !host.navigationCollapsed &&
    host.navigationView === "online";
  let pagesMenu: PopoverHandle | undefined;
  let moreButton: HTMLButtonElement | undefined;
  const [pagesMenuOpen, setPagesMenuOpen] = createSignal(false);
  // "More" carries the current-item fill while the open page has no item of its own on the rail.
  const moreCurrent = createMemo(() => {
    const route = host.activeRouteId;
    if (
      !route ||
      route === "chat" ||
      route === "new-session" ||
      isSettingsTakeover(route) ||
      // People is Activity's own rail item.
      sidebarSectionForRoute(route) === "online"
    ) {
      return false;
    }
    if (route === "plugin") {
      return !pins().includes(`plugin:${host.activePluginTabId}`);
    }
    return !pins().some((entry) => {
      const pinned = parseSidebarEntry(entry);
      return pinned?.type === "route" && isSidebarRouteActive(route, pinned.route);
    });
  });
  return [
    <nav
      class="sidebar-rail"
      aria-label={t("nav.pages")}
      data-tooltip-placement="right"
      onMouseDown={beginNativeWindowDragFromTopInset}
    >
      {renderSidebarAgentCard(host)}
      <div class="sidebar-rail__views">
        <openclaw-tooltip prop:content={t("presence.usersTitle")}>
          <button
            ref={[
              elementRef((element: HTMLButtonElement) => {
                host.navigationViewElements.set("online", element);
                return () => {
                  if (host.navigationViewElements.get("online") === element) {
                    host.navigationViewElements.delete("online");
                  }
                };
              }),
            ]}
            type="button"
            class="sidebar-rail__button"
            data-navigation-view="online"
            aria-label={t("presence.usersTitle")}
            aria-pressed={peoplePressed() ? "true" : "false"}
            onClick={() => {
              // People is the Users section: Activity in the content, people in the sidebar.
              host.navigationView = "online";
              if (host.onExitSettings) {
                host.onExitSettings();
              } else if (!isMobileNavLayout() && host.navigationCollapsed) {
                host.onToggleSidebar?.();
              }
              // The mobile drawer closes on navigation, so there People only opens the list.
              if (!isMobileNavLayout()) {
                host.onNavigate?.("activity");
              }
              host.invalidate();
            }}
          >
            <Icon name="users" filled={peoplePressed()} />
          </button>
        </openclaw-tooltip>
      </div>
      <div
        class={[
          "sidebar-rail__pins",
          { "sidebar-rail__pins--drag-active": host.sessionOrganizer.sidebarZoneDragActive },
        ]}
        aria-label={t("nav.customize")}
        onClick={(event) => {
          if (
            event.button !== 0 ||
            event.metaKey ||
            event.ctrlKey ||
            event.shiftKey ||
            event.altKey ||
            !event
              .composedPath()
              .some(
                (target) =>
                  target instanceof Element &&
                  target.matches("a[href], button:not([disabled], [data-navigation-view])"),
              )
          ) {
            return;
          }
          const pin = event
            .composedPath()
            .find(
              (target): target is Element =>
                target instanceof Element && target.hasAttribute("data-sidebar-entry"),
            );
          const entry = pin ? parseSidebarEntry(pin.getAttribute("data-sidebar-entry")) : null;
          if (entry) {
            revealDestination(host, entry);
          }
        }}
        onDragOver={(event) => host.sessionOrganizer.handleSidebarZoneDragOver(event)}
        onDragLeave={(event) => host.sessionOrganizer.handleSidebarZoneDragLeave(event)}
        onDrop={(event) => host.sessionOrganizer.handleSidebarZoneDrop(event)}
      >
        <For each={sectionPins()}>
          {(key) => renderRailPin(host, parseSidebarEntry(key)!, zone)}
        </For>
        <openclaw-tooltip prop:content={t("nav.pages")}>
          <button
            ref={(element) => (moreButton = element)}
            type="button"
            class={[
              "sidebar-rail__button sidebar-rail__more",
              { "nav-item--active": moreCurrent() },
            ]}
            data-rail-more=""
            aria-label={t("nav.pages")}
            aria-haspopup="dialog"
            aria-controls="sidebar-pages-menu"
            aria-expanded={pagesMenuOpen() ? "true" : "false"}
            onClick={() => (pagesMenuOpen() ? pagesMenu?.hide() : pagesMenu?.show())}
          >
            <Icon name="moreHorizontal" />
          </button>
        </openclaw-tooltip>
        <Show when={otherPins().length > 0}>
          <span class="sidebar-rail__separator" aria-hidden="true" />
        </Show>
        <For each={otherPins()}>{(key) => renderRailPin(host, parseSidebarEntry(key)!, zone)}</For>
      </div>
      <div class="sidebar-rail__bottom">{renderAppSidebarFooterBar(host)}</div>
    </nav>,
    // Outside the rail so its rows keep full Pages styling instead of icon-only rail controls.
    <Popover
      id="sidebar-pages-menu"
      label={t("nav.pages")}
      class="sidebar-pages-menu-popover"
      anchor={moreButton}
      placement="right-start"
      lazy
      dismissOutsidePointer
      dismissOutsideFocus
      onOpenChange={setPagesMenuOpen}
      ref={(handle) => (pagesMenu = handle)}
    >
      <SidebarViewBoundary>
        <SidebarPagesMenu
          host={host}
          onNavigate={(entry) => {
            pagesMenu?.hide();
            if (entry) {
              revealDestination(host, entry);
            }
          }}
        />
      </SidebarViewBoundary>
    </Popover>,
  ];
}

function renderRailPin(
  host: AppSidebarRenderHost,
  entry: SidebarZoneEntry,
  zone: () => SidebarZone,
): JSX.Element {
  const serialized = serializeSidebarEntry(entry);
  const session = () => (entry.type === "session" ? zone().sessionRows.get(entry.key) : undefined);
  const owner = () =>
    entry.type === "person"
      ? host.sessionOwnerOptions.find(
          (candidate) => candidate.type === "human" && candidate.id === entry.profileId,
        )
      : undefined;
  const online = createMemo(() =>
    entry.type === "person"
      ? (
          host.sidebarSnapshot?.onlineUsers ??
          projectOnlinePresenceViewers(host.sessionData.presencePayload)
        ).find(
          (person) => person.identity?.type === "profile" && person.identity.id === entry.profileId,
        )
      : undefined,
  );
  const plugin = () =>
    entry.type === "plugin"
      ? host.pluginNavigation().find((candidate) => candidate.key === entry.key)
      : undefined;
  const tab = () => (entry.type === "plugin" ? zone().pluginTabs.get(entry.key) : undefined);
  const label = () =>
    entry.type === "route"
      ? titleForRoute(entry.route)
      : entry.type === "person"
        ? owner()?.label || (online() ? presenceViewerLabel(online()!) : t("nav.owner"))
        : session()?.label ||
          plugin()?.value.label ||
          tab()?.label ||
          t(entry.type === "session" ? "sessionsView.openSession" : "tabs.plugin");
  const person = () =>
    entry.type === "person"
      ? personActivityLink(
          entry.profileId,
          personActivityRouting({
            basePath: host.basePath,
            navigate: (route, options) => host.onNavigate?.(route, options),
          }),
        )
      : null;
  let trigger: HTMLElement | undefined;
  const triggerRef = (element: HTMLAnchorElement) => (trigger = element);
  const content =
    entry.type === "person" ? (
      <a
        ref={triggerRef}
        class="sidebar-rail__button"
        draggable="false"
        href={person()?.href}
        aria-label={label()}
        onClick={(event) => person()?.open(event)}
      >
        <Show
          when={owner()}
          fallback={
            <Show when={online()} fallback={<Icon name="users" />}>
              {(user) => <openclaw-viewer-avatar prop:user={user()} variant="footer" />}
            </Show>
          }
        >
          {(user) => <SessionOwnerAvatar owner={user()} />}
        </Show>
      </a>
    ) : entry.type === "route" ? (
      host.sidebarMenus.renderRoute(entry.route, host, triggerRef)
    ) : (
      <Show
        when={session()}
        fallback={
          entry.type === "plugin" ? (
            <Show
              when={tab()}
              fallback={
                <Show when={plugin()} fallback={undefined}>
                  <openclaw-plugin-contributions
                    prop:kind={"navigation"}
                    prop:navigationKey={entry.key}
                    prop:navigationChildren={false}
                    prop:navigationMenus={host.sidebarMenus}
                  />
                </Show>
              }
            >
              {(item) => renderAppSidebarPluginTab(host, item, triggerRef)}
            </Show>
          ) : undefined
        }
      >
        {(row) => (
          <a
            ref={triggerRef}
            class="sidebar-rail__button"
            draggable="false"
            href={host.sidebarSessionHref(row())}
            aria-label={label()}
            aria-current={row().active ? "page" : undefined}
            onClick={(event) =>
              handleNavigationClick(event, () => host.selectSession(row().key, undefined, row()))
            }
          >
            <RailSessionGlyph session={row()} label={label()} />
          </a>
        )}
      </Show>
    );
  const drop = () => host.sessionOrganizer.sidebarZoneDropTarget;
  let pin: HTMLDivElement | undefined;
  let press: RailPinTouchPress | undefined;
  const cancelTouchPress = (event?: Event) => {
    if (!press || (event instanceof PointerEvent && event.pointerId !== press.pointerId)) {
      return;
    }
    clearTimeout(press.timer);
    press.timer = undefined;
    if (!press.opened) {
      press = undefined;
    }
  };
  const captureClick = (event: MouseEvent) => {
    if (!press?.opened) {
      return;
    }
    press = undefined;
    if (event.detail !== 0) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  };
  const openMenu = (event: MouseEvent | KeyboardEvent) => {
    if (!host.sidebarSnapshot) {
      handleContextMenuEvent(event, trigger ?? pin ?? null, (menuTrigger, x, y) =>
        host.sidebarMenus.openRailPinMenu(serialized, label(), x, y, menuTrigger),
      );
    }
  };
  onSettled(() => () => {
    clearTimeout(press?.timer);
    if (host.sidebarMenus.railPins.get(serialized) === pin) {
      host.sidebarMenus.railPins.delete(serialized);
    }
  });
  const available = () =>
    entry.type === "person" ||
    Boolean(session()) ||
    (entry.type === "route" && host.sidebarMenus.isRouteEnabled(entry.route)) ||
    (entry.type === "plugin" && Boolean(tab() || plugin()));
  return (
    <Show when={available()}>
      <div
        ref={[
          (element: HTMLDivElement) => {
            pin = element;
            host.sidebarMenus.railPins.set(serialized, element);
          },
          nativeListener("click", captureClick, true),
        ]}
        class={[
          "sidebar-rail__pin",
          drop()?.entry === serialized ? `sidebar-zone-entry--drop-${drop()?.position}` : undefined,
        ]}
        data-sidebar-entry={serialized}
        tabindex={-1}
        title={host.sidebarMenus.railPinMenuPosition ? "" : label()}
        draggable={!host.sidebarSnapshot ? "true" : "false"}
        onContextMenu={openMenu}
        onKeyDown={openMenu}
        onFocusIn={(event) => {
          if (event.target instanceof HTMLElement && event.target.matches("a, button")) {
            trigger = event.target;
          }
        }}
        onPointerDown={(event) => {
          const target = event.target.closest<HTMLElement>("a, button");
          if (target && pin?.contains(target)) {
            trigger = target;
          }
          clearTimeout(press?.timer);
          press = undefined;
          if (host.sidebarSnapshot || event.pointerType !== "touch" || !event.isPrimary) {
            return;
          }
          const current: RailPinTouchPress = {
            pointerId: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            opened: false,
          };
          press = current;
          current.timer = setTimeout(() => {
            current.timer = undefined;
            if (host.sidebarSnapshot || !pin?.isConnected) {
              press = undefined;
              return;
            }
            current.opened = true;
            host.sidebarMenus.openRailPinMenu(
              serialized,
              label(),
              current.x,
              current.y,
              trigger ?? pin,
            );
          }, 500);
        }}
        onPointerMove={(event) => {
          if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 8) {
            cancelTouchPress(event);
          }
        }}
        onPointerUp={cancelTouchPress}
        onPointerCancel={cancelTouchPress}
        onDragStart={(event) => {
          cancelTouchPress(event);
          if (!host.sidebarSnapshot) {
            host.sessionOrganizer.startSidebarEntryDrag(event, entry);
          }
        }}
        onDragEnd={() => host.sessionOrganizer.finishSidebarEntryDrag()}
        onDragOver={(event) => host.sessionOrganizer.handleSidebarZoneDragOver(event, serialized)}
        onDrop={(event) => host.sessionOrganizer.handleSidebarZoneDrop(event, serialized)}
      >
        {content}
      </div>
    </Show>
  );
}

function RailSessionGlyph(props: { session: SidebarRecentSession; label: string }) {
  const subagentsWorking = createMemo(
    () => (props.session.subagentSummary?.runningChildCount ?? props.session.runningChildCount) > 0,
  );
  const graphic = createMemo(() =>
    Boolean(
      props.session.icon &&
      (props.session.icon.startsWith(SESSION_ICON_SVG_DATA_URL_PREFIX) ||
        SESSION_ICON_GLYPH_IDS.some((id) => id === props.session.icon)),
    ),
  );
  const initials = () =>
    (props.label.match(/[\p{L}\p{N}]+/gu) ?? [])
      .slice(0, 2)
      .map((word) => Array.from(word)[0])
      .join("")
      .toUpperCase();
  return (
    <SessionGlyph
      content={
        props.session.icon ? (
          <span
            class={graphic() ? "session-glyph__icon" : "session-glyph__emoji"}
            aria-hidden="true"
          >
            {graphic() ? <SessionIconGraphic icon={props.session.icon} /> : props.session.icon}
          </span>
        ) : (
          <span class="sidebar-rail__monogram" aria-hidden="true">
            {initials() || "?"}
          </span>
        )
      }
      running={
        (props.session.isRunVisuallyActive ?? props.session.hasActiveRun) ||
        subagentsWorking() ||
        (props.session.backgroundProcessCount ?? 0) > 0
      }
      queued={
        (props.session.isRunVisuallyActive ?? props.session.hasActiveRun) &&
        props.session.status === "queued" &&
        !subagentsWorking()
      }
      background={
        !(props.session.isRunVisuallyActive ?? props.session.hasActiveRun) &&
        !subagentsWorking() &&
        (props.session.backgroundProcessCount ?? 0) > 0
      }
      badge={props.session.unread ? renderSessionUnreadBadge() : undefined}
    />
  );
}
