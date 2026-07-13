import { html, nothing } from "lit";
import type {
  SessionCatalog,
  SessionCatalogHost,
  SessionCatalogSession,
} from "../../../packages/gateway-protocol/src/index.ts";
import type { GatewaySessionRow } from "../api/types.ts";
import { pathForRoute } from "../app-route-paths.ts";
import { t } from "../i18n/index.ts";
import { formatRelativeTimestamp } from "../lib/format.ts";
import type { CatalogSessionContinuedDetail } from "../lib/sessions/catalog-key.ts";
import { buildCatalogSessionKey } from "../lib/sessions/catalog-key.ts";
import { searchForSession } from "../lib/sessions/index.ts";
import { shouldHandleNavigationClick } from "./app-sidebar-nav-menus.ts";
import { icons } from "./icons.ts";

export function formatSidebarTimestamp(timestampMs: number | null | undefined): string {
  const value = formatRelativeTimestamp(timestampMs, { fallback: "" });
  if (value === "just now") {
    return "now";
  }
  return value.endsWith(" ago") ? value.slice(0, -" ago".length) : value;
}

/** Session keys already adopted into OpenClaw sessions; the regular list hides
    these so each adopted session stays a single selectable catalog row. */
export function adoptedCatalogSessionKeys(catalogs: readonly SessionCatalog[]): Set<string> {
  const keys = new Set<string>();
  for (const catalog of catalogs) {
    for (const host of catalog.hosts) {
      for (const session of host.sessions) {
        if (session.openClawSessionKey) {
          keys.add(session.openClawSessionKey);
        }
      }
    }
  }
  return keys;
}

/** Stamps a freshly adopted session key onto its catalog row so the sidebar
    binds it before the next catalog poll confirms the adoption. */
export function bindAdoptedCatalogSession(
  catalogs: readonly SessionCatalog[],
  detail: CatalogSessionContinuedDetail,
): SessionCatalog[] {
  return catalogs.map((catalog) =>
    catalog.id === detail.catalogId
      ? {
          ...catalog,
          hosts: catalog.hosts.map((host) =>
            host.hostId === detail.hostId
              ? {
                  ...host,
                  sessions: host.sessions.map((session) =>
                    session.threadId === detail.threadId
                      ? { ...session, openClawSessionKey: detail.sessionKey }
                      : session,
                  ),
                }
              : host,
          ),
        }
      : catalog,
  );
}

type SessionCatalogGroupsParams = {
  catalogs: readonly SessionCatalog[];
  basePath: string;
  routeSessionKey: string;
  collapsedSections: ReadonlySet<string>;
  loadingMoreCatalogIds: ReadonlySet<string>;
  liveRows: readonly GatewaySessionRow[];
  renderLiveRow: (row: GatewaySessionRow) => unknown;
  onToggleSection: (sectionId: string) => void;
  onLoadMore: (catalogId: string) => void;
  onNavigate: (search: string) => void;
};

export function renderSessionCatalogGroups(params: SessionCatalogGroupsParams) {
  // Adopted rows reuse the live session row so activity, unread state, and
  // the session menu behave exactly like the regular list.
  const liveRowsByKey = new Map<string, GatewaySessionRow>();
  for (const row of params.liveRows) {
    if (!liveRowsByKey.has(row.key)) {
      liveRowsByKey.set(row.key, row);
    }
  }
  return params.catalogs.map((catalog) => {
    const sectionId = `catalog:${catalog.id}`;
    const collapsed = params.collapsedSections.has(sectionId);
    const hosts = catalog.hosts;
    const rows = hosts.flatMap((host) => host.sessions.map((session) => ({ host, session })));
    const loadingMore = params.loadingMoreCatalogIds.has(catalog.id);
    const hasMore = hosts.some((host) => Boolean(host.nextCursor));
    const errorMessages = [
      ...(catalog.error ? [catalog.error.message] : []),
      ...hosts.flatMap((host) => (host.error ? [host.error.message] : [])),
    ];
    const hasError = errorMessages.length > 0;
    // Keep provider failures distinguishable from successful empty results.
    // Hiding both states would silently mask unavailable session sources.
    if (rows.length === 0 && !hasMore && !hasError) {
      return nothing;
    }
    const errorMessage = errorMessages.join("; ");
    return html`
      <div class="sidebar-recent-sessions__group" data-session-section=${sectionId}>
        <div class="sidebar-recent-sessions__head">
          <button
            type="button"
            class="sidebar-session-group-toggle"
            aria-expanded=${String(!collapsed)}
            aria-label=${hasError ? `${catalog.label}: ${errorMessage}` : catalog.label}
            title=${hasError ? errorMessage : nothing}
            @click=${() => params.onToggleSection(sectionId)}
          >
            <span class="sidebar-session-group-toggle__icon" aria-hidden="true"
              >${collapsed ? icons.chevronRight : icons.chevronDown}</span
            >
            <span class="sidebar-recent-sessions__label-text">${catalog.label}</span>
            <span
              class="sidebar-session-group-count ${hasError
                ? "sidebar-session-group-count--error"
                : ""}"
              data-session-catalog-error=${hasError ? catalog.id : nothing}
              aria-hidden="true"
              >${hasError ? icons.alertTriangle : rows.length}</span
            >
          </button>
        </div>
        ${collapsed
          ? nothing
          : html`<div class="sidebar-recent-sessions__list">
                ${rows.map(({ host, session }) =>
                  renderCatalogSessionRow(catalog, host, session, liveRowsByKey, params),
                )}
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

function renderCatalogSessionRow(
  catalog: SessionCatalog,
  host: SessionCatalogHost,
  session: SessionCatalogSession,
  liveRowsByKey: ReadonlyMap<string, GatewaySessionRow>,
  params: SessionCatalogGroupsParams,
) {
  const adoptedRow = session.openClawSessionKey
    ? liveRowsByKey.get(session.openClawSessionKey)
    : undefined;
  if (adoptedRow) {
    return params.renderLiveRow(adoptedRow);
  }
  const key =
    session.openClawSessionKey ??
    buildCatalogSessionKey({
      catalogId: catalog.id,
      hostId: host.hostId,
      threadId: session.threadId,
    });
  const search = searchForSession(key);
  const href = `${pathForRoute("chat", params.basePath)}${search}`;
  // The catalog header already names the source; only a paired node's
  // machine name adds signal on the row itself.
  const hostSubtitle = host.kind === "node" ? host.label : undefined;
  const active = params.routeSessionKey !== "" && key === params.routeSessionKey;
  const rawTimestamp = session.recencyAt ?? session.updatedAt ?? session.createdAt;
  const timestamp =
    typeof rawTimestamp === "number" && rawTimestamp < 1_000_000_000_000
      ? rawTimestamp * 1000
      : rawTimestamp;
  return html`
    <div
      class="sidebar-recent-session session-row-host ${active
        ? "sidebar-recent-session--active"
        : ""}"
      data-session-key=${key}
    >
      <a
        href=${href}
        class="sidebar-recent-session__link"
        title=${hostSubtitle
          ? `${session.name || session.threadId} · ${hostSubtitle}`
          : session.name || session.threadId}
        @click=${(event: MouseEvent) => {
          if (!shouldHandleNavigationClick(event)) {
            return;
          }
          event.preventDefault();
          params.onNavigate(search);
        }}
      >
        <span class="sidebar-recent-session__text">
          <span class="sidebar-recent-session__name hover-marquee"
            >${session.name || session.threadId}</span
          >
          ${hostSubtitle
            ? html`<span class="sidebar-recent-session__subtitle">${hostSubtitle}</span>`
            : nothing}
        </span>
        <span class="sidebar-recent-session__aside session-row-aside">
          <span class="session-row-trail">${formatSidebarTimestamp(timestamp)}</span>
        </span>
      </a>
    </div>
  `;
}
