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
import { t } from "../i18n/index.ts";
import { shouldHandleNavigationClick } from "../lib/navigation-click.ts";
import { projectOnlinePresenceViewers, presenceViewerLabel } from "../lib/presence-users.ts";
import { openPersonalPinnedSession } from "./app-sidebar-personal-navigation.ts";
import {
  renderAppSidebarFooterBar,
  renderAppSidebarPluginTab,
  renderAppSidebarPageEntry,
  type AppSidebarRenderHost,
} from "./app-sidebar-render.ts";
import { icons } from "./icons.ts";
import { personActivityLink, personActivityRouting } from "./person-activity-link.ts";
import { renderSessionLeadingState } from "./session-leading-indicator.ts";
import { renderSessionOwnerAvatar } from "./session-owner-chip.ts";
import { renderSidebarReorderMenu } from "./sidebar-reorder.ts";
import { restoreSnapshotSession } from "./sidebar-snapshot-model.ts";

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
    <nav class="sidebar-rail" aria-label=${t("nav.pages")}>
      <div class="sidebar-rail__views">
        ${views.map(
          (view) => html`<openclaw-tooltip .content=${view.label}>
            <button
              type="button"
              class="sidebar-rail__button"
              data-navigation-view=${view.id}
              aria-label=${view.label}
              aria-pressed=${String(host.navigationView === view.id)}
              @click=${() => {
                host.navigationView = view.id;
                if (view.id === "online") {
                  host.teamOnlineExpanded = true;
                  if (host.collapsedSessionSections.has("online")) {
                    host.toggleSection("online");
                  }
                }
                if (host.navigationCollapsed) {
                  host.onToggleSidebar?.();
                }
              }}
            >
              ${view.icon}
            </button>
          </openclaw-tooltip>`,
        )}
      </div>
      <div
        class="sidebar-rail__pins"
        aria-label=${t("nav.customize")}
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
        : session?.label || plugin?.value.label || tab?.label || t("presence.sessions.unavailable");
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
          href=${person!.href}
          aria-label=${label}
          @click=${person!.open}
        >
          ${owner ? renderSessionOwnerAvatar(owner) : online ? html`<openclaw-viewer-avatar .user=${online} variant="footer"></openclaw-viewer-avatar>` : icons.users}
        </a>`
      : session
        ? html`<a
            class="sidebar-rail__button"
            href=${host.sidebarSessionHref(session)}
            aria-label=${label}
            aria-current=${session.active ? "page" : nothing}
            @click=${(event: MouseEvent) => {
              if (shouldHandleNavigationClick(event)) {
                event.preventDefault();
                host.selectSession(session.key, undefined, session);
              }
            }}
            >${renderSessionLeadingState(session, session.owner?.actor, "owned", undefined, undefined, false, session.icon ? undefined : html`<span class="nav-item__icon" aria-hidden="true">${session.boardFace === "dashboard" ? icons.layoutGrid : icons.messageCircle}</span>`).leadingIndicator}</a
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
              : html`<button
                  type="button"
                  class="sidebar-rail__button"
                  aria-label=${label}
                  ?disabled=${entry.type !== "session"}
                  @click=${() => {
                    if (entry.type === "session") {
                      void openPersonalPinnedSession(host, entry.key);
                    }
                  }}
                >
                  ${icons.pin}
                </button>`;
  const drop = host.sessionOrganizer.sidebarZoneDropTarget;
  return html`<div
    class="sidebar-rail__pin ${drop?.entry === serialized ? `sidebar-zone-entry--drop-${drop.position}` : ""}"
    data-sidebar-entry=${serialized}
    draggable=${String(!host.sidebarSnapshot)}
    @dragstart=${(event: DragEvent) => host.sessionOrganizer.startSidebarEntryDrag(event, entry)}
    @dragend=${() => host.sessionOrganizer.finishSidebarEntryDrag()}
    @dragover=${(event: DragEvent) => host.sessionOrganizer.handleSidebarZoneDragOver(event, serialized)}
    @drop=${(event: DragEvent) => host.sessionOrganizer.handleSidebarZoneDrop(event, serialized)}
  >
    <openclaw-tooltip .content=${label}>${content}</openclaw-tooltip>
    ${
      host.sidebarSnapshot
        ? nothing
        : renderSidebarReorderMenu({
            label,
            kind: "entry",
            onRemove: () => host.sessionOrganizer.removeSidebarEntry(serialized),
            onMove: async (target, position) => {
              host.sessionOrganizer.writeSidebarEntryAt(serialized, target, position);
              await host.updateComplete;
            },
          })
    }
  </div>`;
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

export function renderSidebarScope(host: AppSidebarRenderHost) {
  const allFilter = host.sessionOwnerFilter;
  const ownerId = host.sidebarSnapshot ? host.sidebarSnapshot.ownerId : allFilter.ownerId;
  const involvingMe = host.sidebarSnapshot?.involvingMe ?? allFilter.involvingMe;
  const selfId =
    host.sidebarSnapshot?.footer?.id ?? host.sessionDataContext?.gateway.snapshot.selfUser?.id;
  if (
    host.sessionsStatusFilter === "active" &&
    (host.sidebarSnapshot?.scopesEquivalent ?? host.navigationCatalog.scopesEquivalent) &&
    !involvingMe &&
    (!ownerId || ownerId === selfId)
  ) {
    return nothing;
  }
  return html`<div
    class="sidebar-navigation-scope"
    role="group"
    aria-label=${titleForRoute("sessions")}
  >
    ${(["mine", "all"] as const).map(
      (scope) => html`<openclaw-tooltip
        .content=${t(scope === "mine" ? "nav.scopeMine" : "nav.scopeAll")}
      >
        <button
          type="button"
          class="sidebar-rail__button"
          aria-label=${t(scope === "mine" ? "nav.scopeMine" : "nav.scopeAll")}
          aria-pressed=${String(host.effectiveNavigationScope === scope)}
          @click=${() => host.setNavigationScope(scope)}
        >
          ${scope === "mine" ? icons.target : icons.users}
        </button>
      </openclaw-tooltip>`,
    )}
  </div>`;
}
