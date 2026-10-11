import type { JSX } from "@solidjs/web";
import { createMemo, For, Show, untrack, onCleanup } from "solid-js";
import {
  SESSION_ICON_GLYPH_IDS,
  SESSION_ICON_SVG_DATA_URL_PREFIX,
} from "../../../packages/gateway-protocol/src/session-agent-status.ts";
import {
  normalizeSidebarEntries,
  parseSidebarEntry,
  serializeSidebarEntry,
  SIDEBAR_NAV_ROUTES,
  titleForRoute,
  type SidebarZoneEntry,
} from "../app-navigation.ts";
import { isMobileNavLayout } from "../app/mobile-nav-layout.ts";
import { beginNativeWindowDragFromTopInset } from "../app/native-window-drag.ts";
import {
  formatKeyboardShortcutCombo,
  KEYBOARD_SHORTCUT_COMBOS,
} from "../lib/keyboard-shortcut-contract.ts";
import { handleContextMenuEvent } from "../lib/keyboard-shortcuts.ts";
import { shouldHandleNavigationClick } from "../lib/navigation-click.ts";
import { projectOnlinePresenceViewers, presenceViewerLabel } from "../lib/presence-users.ts";
import { t } from "../lib/reactive/i18n.ts";
import {
  renderSidebarAgentCard,
  renderAppSidebarFooterBar,
  renderAppSidebarPluginTab,
  renderAppSidebarPageEntry,
  type AppSidebarRenderHost,
} from "./app-sidebar-render.tsx";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";
import { personActivityLink, personActivityRouting } from "./person-activity-link.ts";
import { SessionIconGraphic } from "./session-icon-glyph-solid.tsx";
import { restoreSnapshotSession } from "./sidebar-snapshot-model.ts";
import { Icon } from "./solid/icon.tsx";
import {
  SessionGlyph,
  renderSessionUnreadBadge,
  renderSessionOwnerAvatar,
} from "./solid/session-presentation.tsx";

type SidebarZone = ReturnType<AppSidebarRenderHost["reconciledSidebarZone"]>;
type RailPinTouchPress = {
  pointerId: number;
  x: number;
  y: number;
  timer?: ReturnType<typeof setTimeout>;
  opened: boolean;
};

export function renderSidebarRail(host: AppSidebarRenderHost): JSX.Element {
  const zone = () => host.reconciledSidebarZone();
  const pins = createMemo(() =>
    (normalizeSidebarEntries(host.sidebarSnapshot?.entries ?? host.sidebarEntries) ?? []).map(
      (entry) => parseSidebarEntry(entry)!,
    ),
  );
  const views = ["pages", "sessions", "online"] as const;
  const viewLabel = (view: (typeof views)[number]) =>
    view === "pages"
      ? t("nav.pages")
      : view === "sessions"
        ? titleForRoute("sessions")
        : t("presence.rosterTitle");
  return (
    <nav
      class="sidebar-rail"
      aria-label={t("nav.pages")}
      onMouseDown={beginNativeWindowDragFromTopInset}
    >
      {renderSidebarAgentCard(host)}
      <div class="sidebar-rail__views">
        <For each={views}>
          {(view) => (
            <openclaw-tooltip
              prop:content={
                host.navigationView === view
                  ? `${viewLabel(view)} · ${t(host.navigationCollapsed ? "nav.expand" : "nav.collapse")} (${formatKeyboardShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.toggleSidebar)})`
                  : viewLabel(view)
              }
            >
              <button
                type="button"
                class="sidebar-rail__button"
                data-navigation-view={view}
                aria-label={viewLabel(view)}
                aria-pressed={host.navigationView === view ? "true" : "false"}
                onClick={() => {
                  const active = host.navigationView === view;
                  host.navigationView = view;
                  if (view === "online") {
                    host.teamOnlineExpanded = true;
                    if (host.collapsedSessionSections.has("online")) {
                      host.toggleSection("online");
                    }
                  }
                  if (!isMobileNavLayout() && (active || host.navigationCollapsed)) {
                    host.onToggleSidebar?.();
                  }
                  host.requestUpdate();
                }}
              >
                <Icon
                  name={
                    view === "pages"
                      ? "layoutGrid"
                      : view === "sessions"
                        ? "messageCircle"
                        : "users"
                  }
                />
              </button>
            </openclaw-tooltip>
          )}
        </For>
      </div>
      <openclaw-tooltip
        prop:content={`${t("chat.openCommandPalette")} (${formatKeyboardShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.commandPalette)})`}
      >
        <button
          type="button"
          class="sidebar-rail__button sidebar-brand__search sidebar-brand__desktop-control"
          aria-label={t("chat.openCommandPalette")}
          disabled={!host.onOpenPalette}
          onClick={() => host.onOpenPalette?.()}
        >
          <Icon name="search" />
        </button>
      </openclaw-tooltip>
      <div
        class={[
          "sidebar-rail__pins",
          { "sidebar-rail__pins--drag-active": host.sessionOrganizer.sidebarZoneDragActive },
        ]}
        aria-label={t("nav.customize")}
        onClick={(event) => {
          if (
            !isMobileNavLayout() &&
            !host.navigationCollapsed &&
            event.button === 0 &&
            !event.metaKey &&
            !event.ctrlKey &&
            !event.shiftKey &&
            !event.altKey &&
            event
              .composedPath()
              .some(
                (target) =>
                  target instanceof Element && target.matches("a[href], button:not([disabled])"),
              )
          ) {
            host.onToggleSidebar?.();
          }
        }}
        onDragOver={(event) => host.sessionOrganizer.handleSidebarZoneDragOver(event)}
        onDragLeave={(event) => host.sessionOrganizer.handleSidebarZoneDragLeave(event)}
        onDrop={(event) => host.sessionOrganizer.handleSidebarZoneDrop(event)}
      >
        <For each={pins()} keyed={serializeSidebarEntry}>
          {(entry) => renderRailPin(host, untrack(entry), zone)}
        </For>
      </div>
      <div class="sidebar-rail__bottom">{renderAppSidebarFooterBar(host)}</div>
    </nav>
  );
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
  const content =
    entry.type === "person" ? (
      <a
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
          {(user) => renderSessionOwnerAvatar(user())}
        </Show>
      </a>
    ) : (
      <Show
        when={session()}
        fallback={
          entry.type === "route" ? (
            <Show when={host.sidebarMenus.isRouteEnabled(entry.route)} fallback={undefined}>
              {host.sidebarMenus.renderRoute(entry.route)}
            </Show>
          ) : entry.type === "plugin" ? (
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
              {(item) => renderAppSidebarPluginTab(host, item)}
            </Show>
          ) : undefined
        }
      >
        {(row) => (
          <a
            class="sidebar-rail__button"
            draggable="false"
            href={host.sidebarSessionHref(row())}
            aria-label={label()}
            aria-current={row().active ? "page" : undefined}
            onClick={(event) => {
              if (shouldHandleNavigationClick(event)) {
                event.preventDefault();
                host.selectSession(row().key, undefined, row());
              }
            }}
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
      handleContextMenuEvent(event, pin?.querySelector("a, button") ?? null, (trigger, x, y) =>
        host.sidebarMenus.openRailPinMenu(serialized, label(), x, y, trigger),
      );
    }
  };
  onCleanup(() => {
    clearTimeout(press?.timer);
    pin?.removeEventListener("click", captureClick, true);
  });
  const available = () =>
    entry.type === "person" ||
    Boolean(session()) ||
    (entry.type === "route" && host.sidebarMenus.isRouteEnabled(entry.route)) ||
    (entry.type === "plugin" && Boolean(tab() || plugin()));
  return (
    <Show when={available()}>
      <div
        ref={(element) => {
          pin = element;
          element.addEventListener("click", captureClick, true);
        }}
        class={[
          "sidebar-rail__pin",
          drop()?.entry === serialized ? `sidebar-zone-entry--drop-${drop()?.position}` : undefined,
        ]}
        data-sidebar-entry={serialized}
        draggable={!host.sidebarSnapshot ? "true" : "false"}
        onContextMenu={openMenu}
        onKeyDown={openMenu}
        onPointerDown={(event) => {
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
            const trigger = pin?.querySelector<HTMLElement>("a, button");
            if (host.sidebarSnapshot || !pin?.isConnected || !trigger) {
              press = undefined;
              return;
            }
            current.opened = true;
            host.sidebarMenus.openRailPinMenu(serialized, label(), current.x, current.y, trigger);
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
        <openclaw-tooltip prop:content={label()}>{content}</openclaw-tooltip>
      </div>
    </Show>
  );
}

function RailSessionGlyph(props: { session: SidebarRecentSession; label: string }) {
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
      running={props.session.hasActiveRun || props.session.runningChildCount > 0}
      queued={
        props.session.hasActiveRun &&
        props.session.status === "queued" &&
        props.session.runningChildCount === 0
      }
      badge={props.session.unread ? renderSessionUnreadBadge() : undefined}
    />
  );
}

/** Pages is the accessible destination catalog, not another favorites list. */
export function renderSidebarPages(host: AppSidebarRenderHost): JSX.Element {
  const zone = () => host.reconciledSidebarZone();
  const dashboards = () => host.navigationCatalog.dashboards;
  const dashboardRows = createMemo(() =>
    host.sidebarSnapshot
      ? host.sidebarSnapshot.pages.map((row) =>
          restoreSnapshotSession(row, host.getRouteSessionKey()),
        )
      : (dashboards()?.result?.sessions ?? []).map((row) =>
          host.getSessionNavigationState().toSidebarSession(row),
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
    const result: SidebarZoneEntry[] = SIDEBAR_NAV_ROUTES.filter((route) =>
      host.sidebarMenus.isRouteEnabled(route),
    ).map((route) => ({ type: "route", route }));
    for (const key of new Set([
      ...zone().pluginTabs.keys(),
      ...host.pluginNavigation().map((entry) => entry.key),
    ])) {
      result.push({ type: "plugin", key });
    }
    for (const row of dashboardRows()) {
      result.push({ type: "session", key: row.key });
    }
    return result;
  });
  return (
    <nav
      class="sidebar-pages"
      aria-label={t("nav.pages")}
      onDragOver={(event) => host.sessionOrganizer.handleSessionListDragOver(event)}
      onDrop={(event) => host.sessionOrganizer.handleSessionListDrop(event)}
    >
      <div class="sidebar-pages__heading">{t("nav.pages")}</div>
      <openclaw-mcp-app-catalog surface="sidebar" />
      <For each={entries()} keyed={serializeSidebarEntry}>
        {(entry) => {
          const fixedEntry = untrack(entry);
          const key = serializeSidebarEntry(fixedEntry);
          return (
            <div class="sidebar-pages__entry">
              {renderAppSidebarPageEntry(host, fixedEntry, rows, () => zone().pluginTabs)}
              <button
                type="button"
                class="sidebar-pages__pin"
                disabled={Boolean(host.sidebarSnapshot)}
                aria-label={t(host.sidebarEntries.includes(key) ? "nav.unpin" : "nav.pin")}
                onClick={() => {
                  if (host.sidebarEntries.includes(key)) {
                    host.sessionOrganizer.removeSidebarEntry(key);
                  } else {
                    host.sessionOrganizer.writeSidebarEntryAt(key, undefined, undefined);
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
          onClick={() => host.navigationCatalog.loadMoreDashboards()}
        >
          {t("chat.selectors.loadMoreSessions")}
        </button>
      </Show>
    </nav>
  );
}
