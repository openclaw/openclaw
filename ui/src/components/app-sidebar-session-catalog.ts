import { html, nothing } from "lit";
import type { SessionCatalog } from "../../../packages/gateway-protocol/src/index.ts";
import type { SessionsListResult } from "../api/types.ts";
import { pathForRoute } from "../app-route-paths.ts";
import { t } from "../i18n/index.ts";
import { buildCatalogSessionKey } from "../lib/sessions/catalog-key.ts";
import { searchForSession } from "../lib/sessions/index.ts";
import { shouldHandleNavigationClick } from "./app-sidebar-nav-menus.ts";
import { icons } from "./icons.ts";

type SessionRow = SessionsListResult["sessions"][number];

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

function catalogBackingSessionRow(
  sessionKey: string,
  currentRows: readonly SessionRow[],
  rowsByAgent: Readonly<Record<string, readonly SessionRow[]>>,
): SessionRow | undefined {
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

type SidebarSessionCatalogParams = {
  catalogs: readonly SessionCatalog[];
  collapsedSectionIds: ReadonlySet<string>;
  loadingMoreCatalogIds: ReadonlySet<string>;
  connected: boolean;
  defaultAgentId: string;
  activeRouteId: string | undefined;
  routeSessionKey: string;
  basePath: string;
  currentRows: readonly SessionRow[];
  rowsByAgent: Readonly<Record<string, readonly SessionRow[]>>;
  formatTimestamp: (timestampMs: number | null | undefined) => string;
  onToggleSection: (sectionId: string) => void;
  onOpenNewSession: (agentId: string, target: { catalogId: string }) => void;
  onNavigateSession: (search: string) => void;
  onLoadMore: (catalogId: string) => void;
};

export function renderSidebarSessionCatalogs(params: SidebarSessionCatalogParams) {
  const backingRow = (sessionKey: string) =>
    catalogBackingSessionRow(sessionKey, params.currentRows, params.rowsByAgent);

  // Catalog groups stay inside the shared sessions scroller. A sibling section
  // would form a scroll-less region that can paint over the following content.
  return params.catalogs.map((catalog) => {
    const sectionId = `catalog:${catalog.id}`;
    const collapsed = params.collapsedSectionIds.has(sectionId);
    const hosts = catalog.hosts;
    const rows = hosts.flatMap((host) => host.sessions.map((session) => ({ host, session })));
    const backingRows = rows.flatMap(({ session }) => {
      const row = session.openClawSessionKey ? backingRow(session.openClawSessionKey) : undefined;
      return row ? [row] : [];
    });
    const hasActiveRun = backingRows.some((row) => row.hasActiveRun === true);
    const hasUnread = backingRows.some((row) => row.unread === true);
    const loadingMore = params.loadingMoreCatalogIds.has(catalog.id);
    const hasMore = hosts.some((host) => Boolean(host.nextCursor));
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
            ${hasActiveRun
              ? html`<span
                  class="session-run-spinner"
                  role="img"
                  aria-label=${t("sessionsView.activeRun")}
                  title=${t("sessionsView.activeRun")}
                ></span>`
              : hasUnread
                ? html`<span
                    class="session-unread-dot"
                    role="img"
                    aria-label=${t("sessionsView.unread")}
                  ></span>`
                : nothing}
            <span class="sidebar-session-group-count">${rows.length}</span>
          </button>
          ${catalog.capabilities.createSession
            ? html`<button
                type="button"
                class="sidebar-session-sort sidebar-session-new sidebar-session-catalog-new"
                title=${`${t("chat.runControls.newSession")} — ${catalog.label}`}
                aria-label=${`${t("chat.runControls.newSession")} — ${catalog.label}`}
                ?disabled=${!params.connected}
                @click=${() =>
                  params.onOpenNewSession(params.defaultAgentId, { catalogId: catalog.id })}
              >
                ${icons.plus}
              </button>`
            : nothing}
        </div>
        ${collapsed
          ? nothing
          : html`<div class="sidebar-recent-sessions__list">
                ${rows.map(({ host, session }) => {
                  const key =
                    session.openClawSessionKey ??
                    buildCatalogSessionKey({
                      catalogId: catalog.id,
                      hostId: host.hostId,
                      threadId: session.threadId,
                    });
                  const href = `${pathForRoute("chat", params.basePath)}${searchForSession(key)}`;
                  const hostSubtitle =
                    catalog.hosts.length > 1 || host.kind === "node" ? host.label : undefined;
                  const rawTimestamp =
                    session.recencyAt ?? session.updatedAt ?? session.createdAt;
                  const timestamp =
                    typeof rawTimestamp === "number" && rawTimestamp < 1_000_000_000_000
                      ? rawTimestamp * 1000
                      : rawTimestamp;
                  const visuallyActive =
                    params.activeRouteId === "chat" && params.routeSessionKey === key;
                  const row = session.openClawSessionKey
                    ? backingRow(session.openClawSessionKey)
                    : undefined;
                  const rowHasActiveRun = row?.hasActiveRun === true;
                  const unread = row?.unread === true;
                  const rowClass = [
                    "sidebar-recent-session",
                    "session-row-host",
                    visuallyActive ? "sidebar-recent-session--active" : "",
                    rowHasActiveRun ? "session-row-host--running" : "",
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
                          if (!shouldHandleNavigationClick(event)) {
                            return;
                          }
                          event.preventDefault();
                          params.onNavigateSession(searchForSession(key));
                        }}
                      >
                        ${rowHasActiveRun
                          ? html`<span
                              class="session-run-spinner sidebar-recent-session__state"
                              role="img"
                              aria-label=${t("sessionsView.activeRun")}
                              title=${t("sessionsView.activeRun")}
                            ></span>`
                          : unread
                            ? html`<span
                                class="session-unread-dot sidebar-recent-session__unread"
                                role="img"
                                aria-label=${t("sessionsView.unread")}
                              ></span>`
                            : nothing}
                        <span class="sidebar-recent-session__text">
                          <span class="sidebar-recent-session__name hover-marquee"
                            >${session.name || session.threadId}</span
                          >
                          ${hostSubtitle
                            ? html`<span class="sidebar-recent-session__subtitle"
                                >${hostSubtitle}</span
                              >`
                            : nothing}
                        </span>
                        <span class="sidebar-recent-session__aside session-row-aside">
                          <span class="session-row-trail"
                            >${params.formatTimestamp(timestamp)}</span
                          >
                        </span>
                      </a>
                    </div>
                  `;
                })}
              </div>
              ${hasMore
                ? html`<button
                    type="button"
                    class="sidebar-session-catalog-load-more"
                    data-session-catalog-load-more=${catalog.id}
                    ?disabled=${loadingMore}
                    aria-busy=${String(loadingMore)}
                    @click=${() => params.onLoadMore(catalog.id)}
                  >
                    ${t("chat.selectors.loadMoreSessions")}
                  </button>`
                : nothing}`}
      </div>
    `;
  });
}
