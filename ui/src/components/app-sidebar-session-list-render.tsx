import type { JSX } from "@solidjs/web";
import { createMemo, For, Show } from "solid-js";
import type { GatewaySessionRow } from "../api/types.ts";
import type { CatalogOpenTarget } from "../app/settings.ts";
import { readPresenceEntries, resolveCurrentSelfUser } from "../app/user-profile.ts";
import { registerSessionOrganizationEnglish } from "../i18n/locales/en-session-organization.ts";
import {
  presenceViewerActivity,
  type PresenceActivity,
  projectPresenceViewers,
} from "../lib/presence-users.ts";
import { registerEnglishCatalog, t } from "../lib/reactive/i18n.ts";
import type { CatalogProjectGrouping } from "../lib/sessions/catalog-project-grouping.ts";
import { openCatalogSessionInTerminal } from "../lib/sessions/catalog-terminal.ts";
import type { SessionCatalogGroupsRenderer } from "./app-sidebar-session-catalog-render.tsx";
import type { SidebarSessionCatalog } from "./app-sidebar-session-catalogs.ts";
import {
  renderPersonalSessionEmpty,
  renderSessionListToolbar,
  renderSessionMutationError,
} from "./app-sidebar-session-filter-summary.tsx";
import type {
  SessionListHost,
  RenderableSessionSection,
  SidebarSessionListHost,
  PersonHeaders,
} from "./app-sidebar-session-render-types.ts";
import {
  renderChildSessionLoadError,
  renderRecentSession,
} from "./app-sidebar-session-row-render.tsx";
import { renderSessionSection } from "./app-sidebar-session-section-render.tsx";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";
import { SIDEBAR_SESSION_PAGE_SIZE } from "./app-sidebar-session-types.ts";
import { areSessionCatalogsSettled } from "./session-data-controller-catalog.ts";

registerEnglishCatalog(registerSessionOrganizationEnglish);
type SessionCatalogRenderSnapshot = {
  catalogs: readonly SidebarSessionCatalog[];
  basePath: string;
  routeSessionKey: string;
  newSessionAgentId: string;
  mainKey: string;
  loadingMoreCatalogIds: ReadonlySet<string>;
  projectGrouping: CatalogProjectGrouping;
  liveRows: readonly GatewaySessionRow[];
  toSidebarSession: (row: GatewaySessionRow) => SidebarRecentSession;
  catalogOpenTarget: CatalogOpenTarget;
  terminalAvailable: boolean;
};
/** Fetching a page is useless if the new rows land behind a section's local cap,
 *  so an explicit roster load reveals a page in every section too -- otherwise
 *  the click can look like undefined happened. */
function renderRosterLoadMore(
  host: SidebarSessionListHost,
  sections: RenderableSessionSection[],
  hasMore: boolean | undefined,
  loading: boolean,
) {
  if (!hasMore) {
    return undefined;
  }
  return (
    <div class="sidebar-session-pagination sidebar-session-pagination--roster">
      <button
        type="button"
        class="sidebar-session-pagination__button"
        aria-label={loading ? t("common.loading") : t("chat.selectors.loadMoreRosterSessions")}
        disabled={loading}
        aria-busy={loading ? "true" : "false"}
        onClick={() => {
          // The request owner changes before the DOM commits the disabled attribute.
          // A repeated activation must not reveal local rows during that read.
          if (host.sessionData.sessionsLoading) {
            return;
          }
          void host.sessionData.loadMoreSidebarSessions().then(() => {
            for (const section of sections) {
              host.setVisibleSessionLimit(
                section.id,
                section.visibleLimit + SIDEBAR_SESSION_PAGE_SIZE,
              );
            }
          });
        }}
      >
        {loading ? <span class="session-run-spinner" aria-hidden="true" /> : undefined}
        {loading ? t("common.loading") : t("chat.selectors.loadMoreRosterSessions")}
      </button>
    </div>
  );
}

/** Section paging only reveals rows the roster already holds. Fetching the next
 *  roster page is a list-level action because it feeds every section at once --
 *  bolting it to one section left the others unable to recover missing rows. */

function renderSessionCatalog(params: {
  host: SessionListHost;
  snapshot: SessionCatalogRenderSnapshot;
  catalog: SidebarSessionCatalog;
  renderer: SessionCatalogGroupsRenderer;
}) {
  const host = createMemo(() => params.host),
    snapshot = createMemo(() => params.snapshot),
    catalog = createMemo(() => params.catalog),
    renderer = createMemo(() => params.renderer);
  const newSessionAccess = createMemo(() => host().readNewSessionAccess());
  const groupWriteAccess = createMemo(() =>
    host().readSessionMutationAccess({
      method: "sessions.groups.put",
      requiredScope: "operator.write",
    }),
  );
  return renderer()({
    get catalogs() {
      return [catalog()];
    },
    get basePath() {
      return snapshot().basePath;
    },
    get routeSessionKey() {
      return snapshot().routeSessionKey;
    },
    get newSessionAgentId() {
      return snapshot().newSessionAgentId;
    },
    get mainKey() {
      return snapshot().mainKey;
    },
    get collapsedSections() {
      return host().collapsedSessionSections;
    },
    get loadingMoreCatalogIds() {
      return snapshot().loadingMoreCatalogIds;
    },
    get visibleSessionLimits() {
      return host().sessionData.visibleSessionLimits;
    },
    get projectGrouping() {
      return snapshot().projectGrouping;
    },
    get liveRows() {
      return snapshot().liveRows;
    },
    renderLiveRow: (row, display) =>
      renderRecentSession({
        get host() {
          return host();
        },
        get session() {
          return snapshot().toSidebarSession(row());
        },
        get display() {
          return display;
        },
      }),
    onToggleSection: (sectionId) => host().toggleSection(sectionId),
    get draggingSectionId() {
      return host().sessionOrganizer.draggingSidebarSection;
    },
    get sectionDropTarget() {
      return host().sessionOrganizer.sidebarSectionDropTarget;
    },
    onSectionDragOver: (event, sectionId) =>
      host().sessionOrganizer.sectionDragOver(event, sectionId),
    onSectionDragLeave: (event, sectionId) =>
      host().sessionOrganizer.sectionDragLeave(event, sectionId),
    onSectionDrop: (event, sectionId) => host().sessionOrganizer.sectionDrop(event, sectionId),
    onStartSectionDrag: (sectionId) => host().sessionOrganizer.startSidebarSectionDrag(sectionId),
    onFinishSectionDrag: () => host().sessionOrganizer.finishSidebarSectionDrag(),
    onReorderSection: (source, target, position) =>
      host().sessionOrganizer.reorderSidebarSection(source, target, position),
    get viewMenuOpenCatalogId() {
      return host().sidebarMenus.catalogViewMenuPosition?.catalogId ?? null;
    },
    get ownerFilterActive() {
      return host().sessionOwnerFilterActive;
    },
    onOpenViewMenu: (catalogId, trigger, position) => {
      if (position) {
        host().sidebarMenus.openCatalogViewMenu(catalogId, position.x, position.y, trigger);
        return;
      }
      host().sidebarMenus.toggleCatalogViewMenu(catalogId, trigger);
    },
    onLoadMore: (catalogId) => void host().sessionData.loadMoreSessionCatalog(catalogId),
    onSetVisibleSessionLimit: (sectionId, limit) => host().setVisibleSessionLimit(sectionId, limit),
    onOpenNewSession: (agentId, target) => host().requestOpenNewSession(agentId, target),
    get newSessionDisabledReason() {
      return (() => {
        const access = newSessionAccess();
        return access.allowed ? undefined : access.reason;
      })();
    },
    get sectionDragDisabledReason() {
      return (() => {
        const access = groupWriteAccess();
        return access.allowed ? undefined : access.reason;
      })();
    },
    get onNavigate() {
      return host().onNavigate;
    },
    get catalogOpenTarget() {
      return snapshot().catalogOpenTarget;
    },
    get terminalAvailable() {
      return snapshot().terminalAvailable;
    },
    onOpenTerminal: (key, agentId) => openCatalogSessionInTerminal(host(), key, agentId),
    onOpenMenu: (request, x, y, trigger) =>
      host().sidebarMenus.catalogMenu.open(request, x, y, trigger),
    onCatalogMenuTriggerRendered: (key, element) =>
      host().sidebarMenus.catalogMenu.retargetTrigger(key, element),
    isMenuOpen: (key) => host().sidebarMenus.catalogMenu.isOpenFor(key),
  });
}
function renderSessionListBody(params: {
  host: SidebarSessionListHost;
  sections: RenderableSessionSection[];
  nativeSessionsHaveMore: boolean;
  catalogs: SessionCatalogRenderSnapshot;
  catalogRenderer: SessionCatalogGroupsRenderer | null;
}) {
  const host = createMemo(() => params.host);
  const personHeaders = createMemo<PersonHeaders | undefined>(() => {
    if (host().sessionsGrouping !== "person") {
      return undefined;
    }
    const selfUser = resolveCurrentSelfUser({
      snapshotUser: host().sessionDataContext?.gateway.snapshot.selfUser,
      presenceEntries: readPresenceEntries(host().sessionData.presencePayload),
      presenceInstanceId: host().sessionData.presenceInstanceId,
    });
    const presence = new Map<string, PresenceActivity>();
    for (const user of projectPresenceViewers(
      host().sessionData.presencePayload,
      selfUser,
      host().sessionData.presenceInstanceId,
    )) {
      if (user.identity?.type === "profile") {
        presence.set(user.identity.id, presenceViewerActivity(user));
      }
    }
    return {
      presence,
      selfProfileId: selfUser?.identity?.type === "profile" ? selfUser.identity.id : undefined,
    };
  });
  const catalogsBySectionId = createMemo(
    () => new Map(params.catalogs.catalogs.map((catalog) => [`catalog:${catalog.id}`, catalog])),
  );
  return (
    <For each={params.sections} keyed={(section) => section.id}>
      {(section) => {
        if (section().id.startsWith("catalog:")) {
          return (
            <Show when={params.catalogRenderer && catalogsBySectionId().get(section().id)}>
              {(catalog) =>
                renderSessionCatalog({
                  get host() {
                    return host();
                  },
                  get snapshot() {
                    return params.catalogs;
                  },
                  get catalog() {
                    return catalog();
                  },
                  get renderer() {
                    return params.catalogRenderer!;
                  },
                })
              }
            </Show>
          );
        }
        // Empty personal sections are omitted by the projection. Other empty sections retain their drag destinations.
        return (
          <Show
            when={
              !(section().id === "work" && section().totalRowCount === 0) &&
              !(
                section().id === "ungrouped" &&
                section().totalRowCount === 0 &&
                !params.nativeSessionsHaveMore &&
                !host().sessionOwnershipVisibility.filters &&
                host().sessionsStatusFilter === "active" &&
                host().sessionOrganizer.draggingSessionKey === null
              )
            }
          >
            {renderSessionSection({
              get host() {
                return host();
              },
              get section() {
                return section();
              },
              get personHeaders() {
                return personHeaders();
              },
            })}
          </Show>
        );
      }}
    </For>
  );
}
export function renderSessionList(params: {
  host: SidebarSessionListHost;
  empty: boolean;
  sections: RenderableSessionSection[];
  nativeSessionsHaveMore: boolean;
  nativeSessionsLoading: boolean;
  catalogs: SessionCatalogRenderSnapshot;
  catalogRenderer: SessionCatalogGroupsRenderer | null;
}) {
  const host = createMemo(() => params.host);
  return renderSessionListFrame(
    host(),
    <div class="sidebar-recent-sessions">
      {renderSessionListBody(params)}
      {renderRosterLoadMore(
        host(),
        params.sections,
        params.nativeSessionsHaveMore,
        params.nativeSessionsLoading,
      )}
      {renderPersonalSessionEmpty(
        host(),
        params.empty && params.sections.every((section) => section.totalRowCount === 0),
        host().connected &&
          host().sessionData.sessionsResult !== null &&
          !host().sessionData.sessionsLoading &&
          !host().sessionData.sessionMutationError &&
          !params.nativeSessionsHaveMore &&
          params.catalogs.catalogs.length === 0 &&
          areSessionCatalogsSettled(host().sessionData),
      )}
      {host().sessionsStatusFilter === "archived" && params.empty ? (
        <span class="sidebar-session-empty-hint">{t("sessionsView.noArchivedSessions")}</span>
      ) : undefined}
    </div>,
  );
}
export function renderSessionListFrame(host: SidebarSessionListHost, body: JSX.Element) {
  const home = createMemo(() =>
    host.sidebarAgentsMode === "roster" ? null : host.mainSessionRow(),
  );
  const loadKeys = createMemo(() => {
    const homeValue = home();
    return homeValue
      ? host.projectHomeSession(homeValue, host.expandedAgentId()).childLoadParentKeys
      : [];
  });
  const homeLoadKeys = createMemo(() => {
    const loadKeysValue = loadKeys();
    const homeValue = home();
    return loadKeysValue?.length ? loadKeysValue : homeValue ? [homeValue.key] : [];
  });
  return (
    <section
      class={`sidebar-sessions ${host.sessionOrganizer.sessionListRemovalDrop ? "sidebar-sessions--removal-drop" : ""}`}
      onDragOver={(event: DragEvent) => host.sessionOrganizer.handleSessionListDragOver(event)}
      onDragLeave={(event: DragEvent) => host.sessionOrganizer.handleSessionListDragLeave(event)}
      onDrop={(event: DragEvent) => host.sessionOrganizer.handleSessionListDrop(event)}
    >
      {host.sidebarAgentsMode === "roster" ? undefined : renderSessionListToolbar(host)}
      {host.sessionData.sessionsStartingUp && !host.sidebarSnapshot ? (
        <div
          class="sidebar-session-empty-hint sidebar-session-empty-hint--startup"
          role="status"
          aria-live="polite"
        >
          <span class="btn__spinner" aria-hidden="true" /> {t("agentStartup.short")}
        </div>
      ) : undefined}
      <For each={homeLoadKeys()}>{(key) => renderChildSessionLoadError(host, key)}</For>
      {host.sessionOrganizer.isDraggingChildSession ? (
        <div class="sidebar-session-root-drop" data-session-root-drop="" role="status">
          {t("sessionsView.moveToTopLevel")}
        </div>
      ) : undefined}
      {renderSessionMutationError(host)} {body}
    </section>
  );
}
export { renderSessionSection };
