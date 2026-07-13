import { html, nothing } from "lit";
import type {
  SessionCatalog,
  SessionCatalogHost,
  SessionCatalogSession,
} from "../../../packages/gateway-protocol/src/index.ts";
import type { SessionsListResult } from "../api/types.ts";
import type { NavigationRouteId } from "../app-navigation.ts";
import { pathForRoute } from "../app-route-paths.ts";
import type { ApplicationNavigationOptions } from "../app/context.ts";
import { t } from "../i18n/index.ts";
import { buildCatalogSessionKey } from "../lib/sessions/catalog-key.ts";
import { searchForSession } from "../lib/sessions/index.ts";
import type { NewSessionTarget } from "../pages/new-session/location.ts";
import { icons } from "./icons.ts";

type SidebarSessionRow = SessionsListResult["sessions"][number];

export function catalogOwnedOpenClawSessionKeys(catalogs: readonly SessionCatalog[]): Set<string> {
  return new Set(
    catalogs.flatMap((catalog) =>
      catalog.hosts.flatMap((host) =>
        host.sessions.flatMap((session) =>
          session.openClawSessionKey ? [session.openClawSessionKey] : [],
        ),
      ),
    ),
  );
}

export function findCatalogBackingSessionRow(
  sessionKey: string,
  currentRows: readonly SidebarSessionRow[],
  rowsByAgent: Readonly<Record<string, readonly SidebarSessionRow[]>>,
): SidebarSessionRow | undefined {
  const current = currentRows.find((row) => row.key === sessionKey);
  if (current) {
    return current;
  }
  for (const rows of Object.values(rowsByAgent)) {
    const row = rows.find((candidate) => candidate.key === sessionKey);
    if (row) {
      return row;
    }
  }
  return undefined;
}

type RenderSidebarSessionCatalogsParams = {
  catalogs: readonly SessionCatalog[];
  collapsedSections: ReadonlySet<string>;
  loadingCatalogIds: ReadonlySet<string>;
  connected: boolean;
  basePath: string;
  activeRouteId?: NavigationRouteId;
  routeSessionKey: string;
  newSessionAgentId: string;
  findBackingSession: (sessionKey: string) => SidebarSessionRow | undefined;
  formatTimestamp: (timestampMs: number | null | undefined) => string;
  shouldHandleNavigationClick: (event: MouseEvent) => boolean;
  onToggleSection: (sectionId: string) => void;
  onOpenNewSession?: (agentId: string, target?: NewSessionTarget) => void;
  onLoadMore: (catalogId: string) => void | Promise<void>;
  onNavigate?: (routeId: NavigationRouteId, options?: ApplicationNavigationOptions) => void;
};

function renderCatalogHeaderStatus(hasActiveRun: boolean, hasUnread: boolean) {
  if (hasActiveRun) {
    return html`<span
      class="session-run-spinner"
      role="img"
      aria-label=${t("sessionsView.activeRun")}
      title=${t("sessionsView.activeRun")}
    ></span>`;
  }
  return hasUnread
    ? html`<span
        class="session-unread-dot"
        role="img"
        aria-label=${t("sessionsView.unread")}
      ></span>`
    : nothing;
}

function renderCatalogRowStatus(hasActiveRun: boolean, unread: boolean) {
  if (hasActiveRun) {
    return html`<span
      class="session-run-spinner sidebar-recent-session__state"
      role="img"
      aria-label=${t("sessionsView.activeRun")}
      title=${t("sessionsView.activeRun")}
    ></span>`;
  }
  return unread
    ? html`<span
        class="session-unread-dot sidebar-recent-session__unread"
        role="img"
        aria-label=${t("sessionsView.unread")}
      ></span>`
    : nothing;
}

function renderCatalogSession(
  params: RenderSidebarSessionCatalogsParams,
  catalog: SessionCatalog,
  host: SessionCatalogHost,
  session: SessionCatalogSession,
) {
  const key =
    session.openClawSessionKey ??
    buildCatalogSessionKey({
      catalogId: catalog.id,
      hostId: host.hostId,
      threadId: session.threadId,
    });
  const search = searchForSession(key);
  const href = `${pathForRoute("chat", params.basePath)}${search}`;
  const hostSubtitle = catalog.hosts.length > 1 || host.kind === "node" ? host.label : undefined;
  const rawTimestamp = session.recencyAt ?? session.updatedAt ?? session.createdAt;
  const timestamp =
    typeof rawTimestamp === "number" && rawTimestamp < 1_000_000_000_000
      ? rawTimestamp * 1000
      : rawTimestamp;
  const visuallyActive = params.activeRouteId === "chat" && params.routeSessionKey === key;
  const backingRow = session.openClawSessionKey
    ? params.findBackingSession(session.openClawSessionKey)
    : undefined;
  const hasActiveRun = backingRow?.hasActiveRun === true;
  const unread = backingRow?.unread === true;
  const rowClass = [
    "sidebar-recent-session",
    "session-row-host",
    visuallyActive ? "sidebar-recent-session--active" : "",
    hasActiveRun ? "session-row-host--running" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return html`
    <div class=${rowClass} data-session-key=${key}>
      <a
        href=${href}
        class="sidebar-recent-session__link"
        title=${`${session.name || session.threadId} · ${host.label}`}
        @click=${(event: MouseEvent) => {
          if (!params.shouldHandleNavigationClick(event)) {
            return;
          }
          event.preventDefault();
          params.onNavigate?.("chat", { search });
        }}
      >
        ${renderCatalogRowStatus(hasActiveRun, unread)}
        <span class="sidebar-recent-session__text">
          <span class="sidebar-recent-session__name hover-marquee"
            >${session.name || session.threadId}</span
          >
          ${hostSubtitle
            ? html`<span class="sidebar-recent-session__subtitle">${hostSubtitle}</span>`
            : nothing}
        </span>
        <span class="sidebar-recent-session__aside session-row-aside">
          <span class="session-row-trail">${params.formatTimestamp(timestamp)}</span>
        </span>
      </a>
    </div>
  `;
}

export function renderSidebarSessionCatalogs(params: RenderSidebarSessionCatalogsParams) {
  return params.catalogs.map((catalog) => {
    const sectionId = `catalog:${catalog.id}`;
    const collapsed = params.collapsedSections.has(sectionId);
    const hosts = catalog.hosts;
    const rows = hosts.flatMap((host) => host.sessions.map((session) => ({ host, session })));
    const backingRows = rows.flatMap(({ session }) => {
      const row = session.openClawSessionKey
        ? params.findBackingSession(session.openClawSessionKey)
        : undefined;
      return row ? [row] : [];
    });
    const hasActiveRun = backingRows.some((row) => row.hasActiveRun === true);
    const hasUnread = backingRows.some((row) => row.unread === true);
    const loadingMore = params.loadingCatalogIds.has(catalog.id);
    const hasMore = hosts.some((host) => Boolean(host.nextCursor));
    const createTarget = catalog.capabilities.createSession;
    return html`
      <div class="sidebar-recent-sessions__group" data-session-section=${sectionId}>
        <div class="sidebar-recent-sessions__head">
          <button
            type="button"
            class="sidebar-session-group-toggle"
            aria-expanded=${String(!collapsed)}
            aria-label=${catalog.label}
            @click=${() => params.onToggleSection(sectionId)}
          >
            <span class="sidebar-session-group-toggle__icon" aria-hidden="true"
              >${collapsed ? icons.chevronRight : icons.chevronDown}</span
            >
            <span class="sidebar-recent-sessions__label-text">${catalog.label}</span>
            ${renderCatalogHeaderStatus(hasActiveRun, hasUnread)}
            <span class="sidebar-session-group-count">${rows.length}</span>
          </button>
          ${createTarget
            ? html`<button
                type="button"
                class="sidebar-session-sort sidebar-session-new sidebar-session-catalog-new"
                title=${`${t("chat.runControls.newSession")} — ${catalog.label}`}
                aria-label=${`${t("chat.runControls.newSession")} — ${catalog.label}`}
                ?disabled=${!params.connected}
                @click=${() =>
                  params.onOpenNewSession?.(params.newSessionAgentId, {
                    model: createTarget.model,
                    label: catalog.label,
                  })}
              >
                ${icons.plus}
              </button>`
            : nothing}
        </div>
        ${collapsed
          ? nothing
          : html`<div class="sidebar-recent-sessions__list">
                ${rows.map(({ host, session }) =>
                  renderCatalogSession(params, catalog, host, session),
                )}
              </div>
              ${hasMore
                ? html`<button
                    type="button"
                    class="sidebar-session-catalog-load-more"
                    data-session-catalog-load-more=${catalog.id}
                    ?disabled=${loadingMore}
                    aria-busy=${String(loadingMore)}
                    @click=${() => void params.onLoadMore(catalog.id)}
                  >
                    ${t("chat.selectors.loadMoreSessions")}
                  </button>`
                : nothing}`}
      </div>
    `;
  });
}
