import { createMemo, For, Show } from "solid-js";
import type {
  SessionCatalog,
  SessionCatalogHost,
  SessionCatalogSession,
} from "../../../packages/gateway-protocol/src/index.ts";
import type { GatewaySessionRow } from "../api/types.ts";
import { formatUiError } from "../lib/format-error.ts";
import { t } from "../lib/reactive/i18n.ts";
import { buildCatalogSessionKey } from "../lib/sessions/catalog-key.ts";
import {
  groupCatalogSessionsByPerson,
  groupCatalogSessionsByProject,
} from "../lib/sessions/catalog-project-grouping.ts";
import { renderHoverMarquee } from "../lib/solid/hover-marquee.tsx";
import { renderCatalogSessionRow } from "./app-sidebar-session-catalog-row.tsx";
import {
  catalogErrorMessages,
  catalogSessionActivity,
  catalogSessionRowsByKey,
  type SidebarSessionCatalog,
} from "./app-sidebar-session-catalogs.ts";
import type { SessionCatalogGroupsParams } from "./app-sidebar-session-render-types.ts";
import { renderSidebarSessionSectionHeader as SessionSectionHeader } from "./app-sidebar-session-section-header.tsx";
import { hasProviderBrandIcon } from "./provider-icon-data.ts";
import { Icon } from "./solid/icon.tsx";
import { renderNewSessionLink as NewSessionLink } from "./solid/new-session-link.tsx";
import { ProviderBrandIcon } from "./solid/provider-icon.tsx";
const CATALOG_SESSION_GROUP_LIMIT = 5;
export function renderSessionCatalogGroups(params: SessionCatalogGroupsParams) {
  // Adopted rows use canonical local labels and title snapshots; native catalog
  // refreshes must not rename them or replace the regular session presentation.
  const liveRowsByKey = createMemo(() => catalogSessionRowsByKey(params.snapshot.liveRows));
  return renderCatalogGroup(() => params.catalog, liveRowsByKey, params);
}
export type SessionCatalogGroupsRenderer = typeof renderSessionCatalogGroups;
function renderCatalogHostGroup(
  readCatalog: () => SessionCatalog,
  readHost: () => SessionCatalogHost,
  readLiveRowsByKey: () => ReadonlyMap<string, GatewaySessionRow>,
  params: SessionCatalogGroupsParams,
) {
  const identity = createMemo(() => ({ catalogId: readCatalog().id, hostId: readHost().hostId }));
  const errorHelp = createMemo(() => {
    const readHostValue = readHost();
    return readHostValue.error
      ? formatUiError(`[${readHostValue.error.code}] ${readHostValue.error.message}`)
      : undefined;
  });
  const projectGroups = createMemo(() => {
    const readHostValue = readHost();
    return params.snapshot.projectGrouping === "project"
      ? groupCatalogSessionsByProject(readHostValue.sessions)
      : params.snapshot.projectGrouping === "person"
        ? groupCatalogSessionsByPerson(readHostValue.sessions)
        : null;
  });
  function CatalogRows(rowProps: {
    sessions: readonly SessionCatalogSession[];
    sectionId: string;
    projectChild?: boolean;
  }) {
    const expanded = () =>
      (params.host.sessionData.visibleSessionLimits.get(rowProps.sectionId) ??
        CATALOG_SESSION_GROUP_LIMIT) > CATALOG_SESSION_GROUP_LIMIT;
    return (
      <For
        each={
          expanded() ? rowProps.sessions : rowProps.sessions.slice(0, CATALOG_SESSION_GROUP_LIMIT)
        }
        keyed={(session) =>
          buildCatalogSessionKey({
            catalogId: identity().catalogId,
            hostId: identity().hostId,
            threadId: session.threadId,
            ...(session.sourceHomeId ? { sourceHomeId: session.sourceHomeId } : {}),
          })
        }
      >
        {(session) =>
          renderCatalogSessionRow(
            readCatalog,
            readHost,
            session,
            readLiveRowsByKey,
            params,
            rowProps.projectChild === true,
          )
        }
      </For>
    );
  }
  function CatalogPagination(pageProps: {
    sessions: readonly SessionCatalogSession[];
    sectionId: string;
  }) {
    const expanded = () =>
      (params.host.sessionData.visibleSessionLimits.get(pageProps.sectionId) ??
        CATALOG_SESSION_GROUP_LIMIT) > CATALOG_SESSION_GROUP_LIMIT;
    const label = () => (expanded() ? t("chat.messages.showLess") : t("chat.messages.showMore"));
    return (
      <Show when={pageProps.sessions.length > CATALOG_SESSION_GROUP_LIMIT}>
        <div class="sidebar-session-pagination sidebar-session-pagination--catalog">
          <button
            type="button"
            class="sidebar-session-pagination__button"
            aria-label={label()}
            onClick={() =>
              params.host.setVisibleSessionLimit(
                pageProps.sectionId,
                expanded() ? CATALOG_SESSION_GROUP_LIMIT : pageProps.sessions.length,
              )
            }
          >
            {label()}
          </button>
        </div>
      </Show>
    );
  }
  const flatSessions = createMemo(() => projectGroups()?.ungrouped ?? readHost().sessions);
  const flatSectionId = createMemo(() => {
    const projectGroupsValue = projectGroups();
    const readCatalogValue = readCatalog();
    const readHostValue = readHost();
    return projectGroupsValue
      ? `catalog-${params.snapshot.projectGrouping}-ungrouped:${readCatalogValue.id}:${readHostValue.hostId}`
      : `catalog-host:${readCatalogValue.id}:${readHostValue.hostId}`;
  });
  // Gateway errors stay on the catalog header; node headings remain so remote rows keep their owner.
  const showHostHeading = createMemo(() => readHost().kind !== "gateway");
  return (
    <section class="sidebar-session-catalog-host" data-session-catalog-host={readHost().hostId}>
      {showHostHeading() ? (
        <div
          class="sidebar-session-catalog-host__head"
          aria-label={errorHelp() ? `${readHost().label}: ${errorHelp()}` : readHost().label}
          title={errorHelp() ?? readHost().label}
        >
          <span class="sidebar-session-group-toggle__lead" aria-hidden="true">
            <span class="sidebar-session-group-toggle__icon">
              <Icon name="monitor" />
            </span>
          </span>
          <span class="sidebar-session-catalog-host__label">{readHost().label}</span>
          <span
            class={[
              "sidebar-session-catalog-host__count",
              { "sidebar-session-catalog-host__count--error": Boolean(readHost().error) },
            ]}
            aria-hidden="true"
          >
            {readHost().error ? <Icon name="alertTriangle" /> : readHost().sessions.length}
          </span>
        </div>
      ) : undefined}
      <div class="sidebar-session-catalog-host__sessions" role="list" aria-label={readHost().label}>
        {projectGroups() ? (
          <For each={projectGroups()!.groups} keyed={(group) => group.key}>
            {(group) => {
              const sectionId = createMemo(
                () =>
                  `catalog-${group().kind}:${identity().catalogId}:${identity().hostId}:${group().key}`,
              );
              const legacySectionId = createMemo(() =>
                group().legacySectionKey
                  ? `catalog-project:${readCatalog().id}:${readHost().hostId}:${group().legacySectionKey}`
                  : null,
              );
              const collapsedSectionId = createMemo(() => {
                const legacyId = legacySectionId();
                return params.host.collapsedSessionSections.has(sectionId())
                  ? sectionId()
                  : legacyId && params.host.collapsedSessionSections.has(legacyId)
                    ? legacyId
                    : null;
              });
              const collapsed = createMemo(() => collapsedSectionId() !== null);
              return (
                <div class="sidebar-session-catalog-project" role="listitem">
                  <button
                    type="button"
                    class="sidebar-session-catalog-project__head"
                    data-session-catalog-project={group().key}
                    aria-expanded={collapsed() ? "false" : "true"}
                    title={group().title}
                    onClick={() => params.host.toggleSection(collapsedSectionId() ?? sectionId())}
                  >
                    <span class="sidebar-session-catalog-project__icon" aria-hidden="true">
                      {collapsed() ? <Icon name="chevronRight" /> : <Icon name="chevronDown" />}
                    </span>
                    <span class="sidebar-session-catalog-project__label">{group().label}</span>
                    <span class="sidebar-session-catalog-project__count" aria-hidden="true">
                      {group().sessions.length}
                    </span>
                  </button>
                  {collapsed() ? undefined : (
                    <>
                      <div
                        class="sidebar-session-catalog-project__sessions"
                        role="list"
                        aria-label={`${readHost().label}: ${group().label}`}
                      >
                        <CatalogRows
                          sessions={group().sessions}
                          sectionId={sectionId()}
                          projectChild
                        />
                      </div>
                      <CatalogPagination sessions={group().sessions} sectionId={sectionId()} />
                    </>
                  )}
                </div>
              );
            }}
          </For>
        ) : undefined}
        <CatalogRows sessions={flatSessions()} sectionId={flatSectionId()} />
      </div>
      <CatalogPagination sessions={flatSessions()} sectionId={flatSectionId()} />
    </section>
  );
}
function renderCatalogGroup(
  readCatalog: () => SidebarSessionCatalog,
  readLiveRowsByKey: () => ReadonlyMap<string, GatewaySessionRow>,
  params: SessionCatalogGroupsParams,
) {
  const newSessionAccess = createMemo(() => params.host.readNewSessionAccess());
  const groupWriteAccess = createMemo(() =>
    params.host.readSessionMutationAccess({
      method: "sessions.groups.put",
      requiredScope: "operator.write",
    }),
  );
  const sectionDragDisabledReason = () => {
    const access = groupWriteAccess();
    return access.allowed ? undefined : access.reason;
  };
  const sectionId = createMemo(() => `catalog:${readCatalog().id}`);
  const collapsed = createMemo(() => params.host.collapsedSessionSections.has(sectionId()));
  const rows = createMemo(() => readCatalog().visibleHosts.flatMap((host) => host.sessions));
  const activity = createMemo(() =>
    catalogSessionActivity(
      rows(),
      readLiveRowsByKey(),
      (row) => params.host.sessionDataContext?.sessions.isRunVisuallyActive(row) ?? false,
    ),
  );
  let viewMenuTrigger: HTMLButtonElement | undefined;
  const hasActiveRun = createMemo(() => activity().running);
  const hasUnread = createMemo(() => activity().unread);
  const hasBrandIcon = createMemo(() => hasProviderBrandIcon(readCatalog().id));
  const loadingMore = createMemo(() => params.snapshot.loadingMoreCatalogIds.has(readCatalog().id));
  const hasMore = createMemo(() => readCatalog().hosts.some((host) => Boolean(host.nextCursor)));
  const canCreateSession = createMemo(() => readCatalog().capabilities.startTerminal === true);
  const errorMessages = createMemo(() => catalogErrorMessages(readCatalog()));
  const hasError = createMemo(() => errorMessages().length > 0);
  const errorMessage = createMemo(() => errorMessages().join("; "));
  const errorHelp = createMemo(() =>
    t("chat.sidebar.catalogDiscoveryHelp", {
      error: errorMessage(),
    }),
  );
  return (
    <div
      class={[
        "sidebar-recent-sessions__group sidebar-recent-sessions__group--zone-coding",
        params.host.sessionOrganizer.sidebarSectionDropTarget?.sectionId === sectionId() &&
          `sidebar-recent-sessions__group--section-drop-${params.host.sessionOrganizer.sidebarSectionDropTarget.position}`,
        {
          "sidebar-recent-sessions__group--collapsed": collapsed(),
          "sidebar-recent-sessions__group--dragging":
            params.host.sessionOrganizer.draggingSidebarSection === sectionId(),
        },
      ]}
      data-session-section={sectionId()}
      onDragOver={(event: DragEvent) => {
        if (!sectionDragDisabledReason()) {
          params.host.sessionOrganizer.sectionDragOver(event, sectionId());
        }
      }}
      onDragLeave={(event: DragEvent) => {
        if (!sectionDragDisabledReason()) {
          params.host.sessionOrganizer.sectionDragLeave(event, sectionId());
        }
      }}
      onDrop={(event: DragEvent) => {
        if (!sectionDragDisabledReason()) {
          params.host.sessionOrganizer.sectionDrop(event, sectionId());
        }
      }}
    >
      <SessionSectionHeader
        sectionId={sectionId()}
        sectionHeaders={params.host.sessionOrganizer.sectionHeaders}
        status={
          hasError() || (collapsed() && rows().length > 0)
            ? {
                label: hasError() ? `${readCatalog().label}: ${errorHelp()}` : readCatalog().label,
                expanded: !collapsed(),
                title: hasError() ? errorHelp() : undefined,
                onToggle: () => params.host.toggleSection(sectionId()),
                content: (
                  <span
                    class={[
                      "sidebar-session-group-count",
                      { "sidebar-session-group-count--error": hasError() },
                    ]}
                    data-session-catalog-error={hasError() ? readCatalog().id : undefined}
                    aria-hidden="true"
                  >
                    {hasError() ? <Icon name="alertTriangle" /> : rows().length}
                  </span>
                ),
              }
            : undefined
        }
        disabledReason={sectionDragDisabledReason()}
        onStartDrag={(id) => params.host.sessionOrganizer.startSidebarSectionDrag(id)}
        onFinishDrag={() => params.host.sessionOrganizer.finishSidebarSectionDrag()}
        onContextMenu={(event) => {
          event.preventDefault();
          params.host.sidebarMenus.openCatalogViewMenu(
            readCatalog().id,
            event.clientX,
            event.clientY,
            viewMenuTrigger ?? event.currentTarget,
          );
        }}
        content={
          <>
            <button
              type="button"
              class="sidebar-session-group-toggle"
              aria-expanded={collapsed() ? "false" : "true"}
              aria-label={
                hasError() ? `${readCatalog().label}: ${errorHelp()}` : readCatalog().label
              }
              title={hasError() ? errorHelp() : undefined}
              onClick={() => params.host.toggleSection(sectionId())}
            >
              <span
                class={[
                  "sidebar-session-group-toggle__lead",
                  { "sidebar-session-group-toggle__lead--branded": hasBrandIcon() },
                ]}
                aria-hidden="true"
              >
                {hasBrandIcon() ? (
                  <ProviderBrandIcon
                    provider={readCatalog().id}
                    class="sidebar-session-catalog-provider-icon"
                  />
                ) : undefined}
                <span class="sidebar-session-group-toggle__icon">
                  {collapsed() ? <Icon name="chevronRight" /> : <Icon name="chevronDown" />}
                </span>
              </span>
              {renderHoverMarquee(readCatalog().label, "sidebar-recent-sessions__label-text")}
              {hasActiveRun() ? (
                <span
                  class="session-run-spinner"
                  role="img"
                  aria-label={t("sessionsView.activeRun")}
                  title={t("sessionsView.activeRun")}
                />
              ) : hasUnread() ? (
                <span class="session-unread-dot" role="img" aria-label={t("sessionsView.unread")} />
              ) : undefined}
            </button>
            <button
              ref={(element) => (viewMenuTrigger = element)}
              type="button"
              class={[
                "sidebar-session-group-actions sidebar-session-sort sidebar-session-catalog-grouping",
                { "sidebar-session-sort--filtered": params.host.sessionOwnerFilterActive },
              ]}
              data-session-catalog-view-menu={readCatalog().id}
              title={t("chat.sidebar.catalogViewOptions")}
              aria-label={t("chat.sidebar.catalogViewOptions")}
              aria-haspopup="menu"
              aria-expanded={
                params.host.sidebarMenus.catalogViewMenuPosition?.catalogId === readCatalog().id
                  ? "true"
                  : "false"
              }
              onClick={(event) => {
                event.stopPropagation();
                params.host.sidebarMenus.toggleCatalogViewMenu(
                  readCatalog().id,
                  event.currentTarget,
                );
              }}
            >
              <Icon name="listFilter" />
            </button>
            {canCreateSession() ? (
              <NewSessionLink
                basePath={params.snapshot.basePath}
                agentId={params.snapshot.newSessionAgentId}
                target={{ catalogId: readCatalog().id }}
                class="sidebar-session-group-actions sidebar-session-new sidebar-session-catalog-new"
                label={`${t("chat.runControls.newSession")} — ${readCatalog().label}`}
                disabledReason={(() => {
                  const access = newSessionAccess();
                  return access.allowed ? undefined : access.reason;
                })()}
                onOpen={(agentId, target) => params.host.requestOpenNewSession(agentId, target)}
              />
            ) : undefined}
          </>
        }
      />
      {collapsed() ? undefined : (
        <>
          <div class="sidebar-recent-sessions__list">
            <For each={readCatalog().visibleHosts} keyed={(host) => host.hostId}>
              {(host) => renderCatalogHostGroup(readCatalog, host, readLiveRowsByKey, params)}
            </For>
          </div>
          {hasMore() ? (
            <button
              type="button"
              class="sidebar-session-catalog-load-more"
              data-session-catalog-load-more={readCatalog().id}
              disabled={loadingMore()}
              aria-busy={loadingMore() ? "true" : "false"}
              onClick={() => void params.host.sessionData.loadMoreSessionCatalog(readCatalog().id)}
            >
              {t("chat.selectors.loadMoreSessions")}
            </button>
          ) : undefined}
        </>
      )}
    </div>
  );
}
