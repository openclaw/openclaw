import { html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
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
import { t } from "../i18n/index.ts";
import {
  formatKeyboardShortcutCombo,
  KEYBOARD_SHORTCUT_COMBOS,
} from "../lib/keyboard-shortcut-contract.ts";
import { handleContextMenuEvent } from "../lib/keyboard-shortcuts.ts";
import { shouldHandleNavigationClick } from "../lib/navigation-click.ts";
import { projectOnlinePresenceViewers, presenceViewerLabel } from "../lib/presence-users.ts";
import {
  renderSidebarAgentCard,
  renderAppSidebarFooterBar,
  renderAppSidebarPluginTab,
  renderAppSidebarPageEntry,
  type AppSidebarRenderHost,
} from "./app-sidebar-render.ts";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";
import { icons } from "./icons.ts";
import { personActivityLink, personActivityRouting } from "./person-activity-link.ts";
import { renderSessionGlyph, renderSessionUnreadBadge } from "./session-glyph.ts";
import { resolveSessionIconGraphic } from "./session-icon-glyph-registry.ts";
import { renderSessionOwnerAvatar } from "./session-owner-chip.ts";
import { restoreSnapshotSession } from "./sidebar-snapshot-model.ts";

type RailPinTouchPress = {
  pointerId: number;
  x: number;
  y: number;
  timer?: ReturnType<typeof setTimeout>;
  opened: boolean;
};
// Pin elements survive Lit updates; gesture state must survive with them.
const railPinTouchPresses = new WeakMap<HTMLElement, RailPinTouchPress>();

function cancelRailPinTouchPress(event: Event) {
  // SAFETY: Every binding below attaches this handler to the rail pin div.
  const pin = event.currentTarget as HTMLElement;
  const press = railPinTouchPresses.get(pin);
  if (!press || (event instanceof PointerEvent && event.pointerId !== press.pointerId)) {
    return;
  }
  clearTimeout(press.timer);
  press.timer = undefined;
  if (!press.opened) {
    railPinTouchPresses.delete(pin);
  }
}

const railPinClickCapture = {
  capture: true,
  handleEvent(event: MouseEvent) {
    // SAFETY: Lit installs this capture listener on the rail pin div below.
    const pin = event.currentTarget as HTMLElement;
    const press = railPinTouchPresses.get(pin);
    if (!press?.opened) {
      return;
    }
    railPinTouchPresses.delete(pin);
    if (event.detail === 0) {
      return;
    }
    // Stop before the link navigates or the pins container collapses the list.
    event.preventDefault();
    event.stopImmediatePropagation();
  },
};

export function renderSidebarRail(host: AppSidebarRenderHost) {
  const zone = host.reconciledSidebarZone();
  const pins = (
    normalizeSidebarEntries(host.sidebarSnapshot?.entries ?? host.sidebarEntries) ?? []
  ).map((entry) => parseSidebarEntry(entry)!);
  const views = [
    { id: "pages", label: t("nav.pages"), icon: icons.layoutGrid },
    { id: "sessions", label: titleForRoute("sessions"), icon: icons.messageCircle },
    { id: "online", label: t("presence.rosterTitle"), icon: icons.users },
  ] as const;
  return html`
    <nav
      class="sidebar-rail"
      aria-label=${t("nav.pages")}
      @mousedown=${beginNativeWindowDragFromTopInset}
    >
      ${renderSidebarAgentCard(host)}
      <div class="sidebar-rail__views">
        ${views.map(
          (view) => html`<openclaw-tooltip
            .content=${host.navigationView === view.id ? `${view.label} · ${t(host.navigationCollapsed ? "nav.expand" : "nav.collapse")} (${formatKeyboardShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.toggleSidebar)})` : view.label}
          >
            <button
              type="button"
              class="sidebar-rail__button"
              data-navigation-view=${view.id}
              aria-label=${view.label}
              aria-pressed=${String(host.navigationView === view.id)}
              @click=${() => {
                const active = host.navigationView === view.id;
                host.navigationView = view.id;
                if (view.id === "online") {
                  host.teamOnlineExpanded = true;
                  if (host.collapsedSessionSections.has("online")) {
                    host.toggleSection("online");
                  }
                }
                if (!isMobileNavLayout() && (active || host.navigationCollapsed)) {
                  host.onToggleSidebar?.();
                }
              }}
            >
              ${view.icon}
            </button>
          </openclaw-tooltip>`,
        )}
      </div>
      <openclaw-tooltip
        .content=${`${t("chat.openCommandPalette")} (${formatKeyboardShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.commandPalette)})`}
      >
        <button
          type="button"
          class="sidebar-rail__button sidebar-brand__search sidebar-brand__desktop-control"
          aria-label=${t("chat.openCommandPalette")}
          ?disabled=${!host.onOpenPalette}
          @click=${() => host.onOpenPalette?.()}
        >
          ${icons.search}
        </button>
      </openclaw-tooltip>
      <div
        class="sidebar-rail__pins ${host.sessionOrganizer.sidebarZoneDragActive ? "sidebar-rail__pins--drag-active" : ""}"
        aria-label=${t("nav.customize")}
        @click=${(event: MouseEvent) => {
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
        @dragover=${(event: DragEvent) => host.sessionOrganizer.handleSidebarZoneDragOver(event)}
        @dragleave=${(event: DragEvent) => host.sessionOrganizer.handleSidebarZoneDragLeave(event)}
        @drop=${(event: DragEvent) => host.sessionOrganizer.handleSidebarZoneDrop(event)}
      >
        ${repeat(pins, serializeSidebarEntry, (entry) => renderRailPin(host, entry, zone))}
      </div>
      <div class="sidebar-rail__bottom">${renderAppSidebarFooterBar(host)}</div>
    </nav>
  `;
}

function renderRailPin(
  host: AppSidebarRenderHost,
  entry: SidebarZoneEntry,
  zone: ReturnType<AppSidebarRenderHost["reconciledSidebarZone"]>,
) {
  const serialized = serializeSidebarEntry(entry);
  const session = entry.type === "session" ? zone.sessionRows.get(entry.key) : undefined;
  const owner =
    entry.type === "person"
      ? host.sessionOwnerOptions.find(
          (candidate) => candidate.type === "human" && candidate.id === entry.profileId,
        )
      : undefined;
  const online =
    entry.type === "person"
      ? (
          host.sidebarSnapshot?.onlineUsers ??
          projectOnlinePresenceViewers(host.sessionData.presencePayload)
        ).find(
          (person) => person.identity?.type === "profile" && person.identity.id === entry.profileId,
        )
      : undefined;
  const plugin =
    entry.type === "plugin"
      ? host.pluginNavigation().find((candidate) => candidate.key === entry.key)
      : undefined;
  const tab = entry.type === "plugin" ? zone.pluginTabs.get(entry.key) : undefined;
  const label =
    entry.type === "route"
      ? titleForRoute(entry.route)
      : entry.type === "person"
        ? owner?.label || (online ? presenceViewerLabel(online) : t("nav.owner"))
        : session?.label ||
          plugin?.value.label ||
          tab?.label ||
          t(entry.type === "session" ? "sessionsView.openSession" : "tabs.plugin");
  const person =
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
    entry.type === "person"
      ? html`<a
          class="sidebar-rail__button"
          draggable="false"
          href=${person!.href}
          aria-label=${label}
          @click=${person!.open}
        >
          ${owner ? renderSessionOwnerAvatar(owner) : online ? html`<openclaw-viewer-avatar .user=${online} variant="footer"></openclaw-viewer-avatar>` : icons.users}
        </a>`
      : session
        ? html`<a
            class="sidebar-rail__button"
            draggable="false"
            href=${host.sidebarSessionHref(session)}
            aria-label=${label}
            aria-current=${session.active ? "page" : nothing}
            @click=${(event: MouseEvent) => {
              if (shouldHandleNavigationClick(event)) {
                event.preventDefault();
                host.selectSession(session.key, undefined, session);
              }
            }}
            >${renderRailSessionGlyph(session, label)}</a
          >`
        : entry.type === "route" && host.sidebarMenus.isRouteEnabled(entry.route)
          ? host.sidebarMenus.renderRoute(entry.route)
          : entry.type === "plugin" && tab
            ? renderAppSidebarPluginTab(host, tab)
            : entry.type === "plugin" && plugin
              ? html`<openclaw-plugin-contributions
                  .kind=${"navigation"}
                  .navigationKey=${entry.key}
                  .navigationChildren=${false}
                  .navigationMenus=${host.sidebarMenus}
                ></openclaw-plugin-contributions>`
              : nothing;
  if (content === nothing) {
    return nothing;
  }
  const openMenu = (event: MouseEvent | KeyboardEvent) =>
    !host.sidebarSnapshot &&
    handleContextMenuEvent(
      event,
      // SAFETY: Both context-menu bindings below belong to the rail pin div.
      (event.currentTarget as HTMLElement).querySelector("a, button"),
      (trigger, x, y) => host.sidebarMenus.openRailPinMenu(serialized, label, x, y, trigger),
    );
  const drop = host.sessionOrganizer.sidebarZoneDropTarget;
  return html`<div
    class="sidebar-rail__pin ${drop?.entry === serialized ? `sidebar-zone-entry--drop-${drop.position}` : ""}"
    data-sidebar-entry=${serialized}
    draggable=${String(!host.sidebarSnapshot)}
    @contextmenu=${openMenu}
    @keydown=${openMenu}
    @pointerdown=${(event: PointerEvent) => {
      // SAFETY: This listener is bound directly to the enclosing rail pin div.
      const pin = event.currentTarget as HTMLElement;
      clearTimeout(railPinTouchPresses.get(pin)?.timer);
      railPinTouchPresses.delete(pin);
      if (host.sidebarSnapshot || event.pointerType !== "touch" || !event.isPrimary) {
        return;
      }
      const press: RailPinTouchPress = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        opened: false,
      };
      railPinTouchPresses.set(pin, press);
      press.timer = setTimeout(() => {
        press.timer = undefined;
        const trigger = pin.querySelector<HTMLElement>("a, button");
        if (host.sidebarSnapshot || !pin.isConnected || !trigger) {
          railPinTouchPresses.delete(pin);
          return;
        }
        press.opened = true;
        host.sidebarMenus.openRailPinMenu(serialized, label, press.x, press.y, trigger);
      }, 500);
    }}
    @pointermove=${(event: PointerEvent) => {
      // SAFETY: This listener is bound directly to the enclosing rail pin div.
      const press = railPinTouchPresses.get(event.currentTarget as HTMLElement);
      if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 8) {
        cancelRailPinTouchPress(event);
      }
    }}
    @pointerup=${cancelRailPinTouchPress}
    @pointercancel=${cancelRailPinTouchPress}
    @click=${railPinClickCapture}
    @dragstart=${(event: DragEvent) => {
      cancelRailPinTouchPress(event);
      if (!host.sidebarSnapshot) {
        host.sessionOrganizer.startSidebarEntryDrag(event, entry);
      }
    }}
    @dragend=${() => host.sessionOrganizer.finishSidebarEntryDrag()}
    @dragover=${(event: DragEvent) => host.sessionOrganizer.handleSidebarZoneDragOver(event, serialized)}
    @drop=${(event: DragEvent) => host.sessionOrganizer.handleSidebarZoneDrop(event, serialized)}
  >
    <openclaw-tooltip .content=${label}>${content}</openclaw-tooltip>
  </div>`;
}

function renderRailSessionGlyph(session: SidebarRecentSession, label: string) {
  const { icon } = session;
  const graphic = icon ? resolveSessionIconGraphic(icon) : null;
  const initials = (label.match(/[\p{L}\p{N}]+/gu) ?? [])
    .slice(0, 2)
    .map((word) => Array.from(word)[0])
    .join("")
    .toUpperCase();
  // Rail shortcuts keep their identity even when the session needs attention.
  const content = icon
    ? graphic
      ? html`<span class="session-glyph__icon" aria-hidden="true">${graphic}</span>`
      : html`<span class="session-glyph__emoji" aria-hidden="true">${icon}</span>`
    : html`<span class="sidebar-rail__monogram" aria-hidden="true">${initials || "?"}</span>`;
  return renderSessionGlyph({
    content,
    running: session.hasActiveRun || session.runningChildCount > 0,
    queued: session.hasActiveRun && session.status === "queued" && session.runningChildCount === 0,
    badge: session.unread ? renderSessionUnreadBadge() : nothing,
  });
}

/** Pages is the accessible destination catalog, not another favorites list. */
export function renderSidebarPages(host: AppSidebarRenderHost) {
  const zone = host.reconciledSidebarZone();
  const dashboards = host.navigationCatalog.dashboards;
  const rows = new Map(zone.sessionRows);
  const dashboardRows = host.sidebarSnapshot
    ? host.sidebarSnapshot.pages.map((row) =>
        restoreSnapshotSession(row, host.getRouteSessionKey()),
      )
    : (dashboards?.result?.sessions ?? []).map((row) =>
        host.getSessionNavigationState().toSidebarSession(row),
      );
  for (const row of dashboardRows) {
    rows.set(row.key, row);
  }
  const entries: SidebarZoneEntry[] = [
    ...SIDEBAR_NAV_ROUTES.filter((route) => host.sidebarMenus.isRouteEnabled(route)).map(
      (route) => ({ type: "route" as const, route }),
    ),
    ...new Set([...zone.pluginTabs.keys(), ...host.pluginNavigation().map((entry) => entry.key)]),
  ].map((entry) => (typeof entry === "string" ? { type: "plugin", key: entry } : entry));
  for (const row of dashboardRows) {
    entries.push({ type: "session", key: row.key });
  }
  return html`<nav
    class="sidebar-pages"
    aria-label=${t("nav.pages")}
    @dragover=${(event: DragEvent) => host.sessionOrganizer.handleSessionListDragOver(event)}
    @drop=${(event: DragEvent) => host.sessionOrganizer.handleSessionListDrop(event)}
  >
    <div class="sidebar-pages__heading">${t("nav.pages")}</div>
    <openclaw-mcp-app-catalog surface="sidebar"></openclaw-mcp-app-catalog>
    ${repeat(
      entries,
      serializeSidebarEntry,
      (entry) => html`<div class="sidebar-pages__entry">
        ${renderAppSidebarPageEntry(host, entry, rows, zone.pluginTabs)}
        <button
          type="button"
          class="sidebar-pages__pin"
          ?disabled=${Boolean(host.sidebarSnapshot)}
          aria-label=${t(host.sidebarEntries.includes(serializeSidebarEntry(entry)) ? "nav.unpin" : "nav.pin")}
          @click=${() => {
            const key = serializeSidebarEntry(entry);
            if (host.sidebarEntries.includes(key)) {
              host.sessionOrganizer.removeSidebarEntry(key);
            } else {
              host.sessionOrganizer.writeSidebarEntryAt(key, undefined, undefined);
            }
          }}
        >
          ${icons.pin}
        </button>
      </div>`,
    )}
    ${dashboards?.error ? html`<span role="alert">${dashboards.error}</span>` : nothing}
    ${dashboards?.result?.hasMore ? html`<button type="button" class="btn btn--sm" @click=${() => host.navigationCatalog.loadMoreDashboards()}>${t("chat.selectors.loadMoreSessions")}</button>` : nothing}
  </nav>`;
}
