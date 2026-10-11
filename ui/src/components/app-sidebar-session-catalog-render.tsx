import { createMemo, For, Show } from "solid-js";
import type {
  SessionCatalog,
  SessionCatalogHost,
  SessionCatalogSession,
} from "../../../packages/gateway-protocol/src/index.ts";
import type { GatewaySessionRow } from "../api/types.ts";
import { formatUiError } from "../lib/format-error.ts";
import { t } from "../lib/reactive/i18n.ts";
import { isSessionRunActive } from "../lib/session-run-state.ts";
import { buildCatalogSessionKey } from "../lib/sessions/catalog-key.ts";
import {
  groupCatalogSessionsByPerson,
  groupCatalogSessionsByProject,
} from "../lib/sessions/catalog-project-grouping.ts";
import { renderHoverMarquee } from "../lib/solid/hover-marquee.tsx";
import { renderCatalogSessionRow } from "./app-sidebar-session-catalog-row.tsx";
import {
  catalogErrorMessages,
  type SidebarSessionCatalog,
} from "./app-sidebar-session-catalogs.ts";
import type { SessionCatalogGroupsParams } from "./app-sidebar-session-render-types.ts";
import { renderSidebarSessionSectionHeader } from "./app-sidebar-session-section-header.tsx";
import { hasProviderBrandIcon } from "./provider-icon-data.ts";
import { Icon } from "./solid/icon.tsx";
import { renderNewSessionLink } from "./solid/new-session-link.tsx";
import { ProviderBrandIcon } from "./solid/provider-icon.tsx";
const CATALOG_SESSION_GROUP_LIMIT = 5;
function renderCatalogHeaderStatus(hasActiveRun: boolean, hasUnread: boolean) {
  if (hasActiveRun) {
    return (
      <span
        class="session-run-spinner"
        role="img"
        aria-label={t("sessionsView.activeRun")}
        title={t("sessionsView.activeRun")}
      />
    );
  }
  return hasUnread ? (
    <span class="session-unread-dot" role="img" aria-label={t("sessionsView.unread")} />
  ) : undefined;
}
export function renderSessionCatalogGroups(params: SessionCatalogGroupsParams) {
  // Adopted rows use canonical local labels and title snapshots; native catalog
  // refreshes must not rename them or replace the regular session presentation.
  const liveRowsByKey = createMemo(() => {
    const rows = new Map<string, GatewaySessionRow>();
    for (const row of params.liveRows) {
      if (!rows.has(row.key)) {
        rows.set(row.key, row);
      }
    }
    return rows;
  });
  return (
    <For each={params.catalogs} keyed={(catalog) => catalog.id}>
      {(catalog) => renderCatalogGroup(catalog, liveRowsByKey, params)}
    </For>
  );
}
export type SessionCatalogGroupsRenderer = typeof renderSessionCatalogGroups;
function renderCatalogHostGroup(
  readCatalog: () => SessionCatalog,
  readHost: () => SessionCatalogHost,
  readLiveRowsByKey: () => ReadonlyMap<string, GatewaySessionRow>,
  params: SessionCatalogGroupsParams,
) {
  const errorHelp = createMemo(() => {
    const readHostValue = readHost();
    return readHostValue.error
      ? formatUiError(`[${readHostValue.error.code}] ${readHostValue.error.message}`)
      : undefined;
  });
  const projectGroups = createMemo(() => {
    const readHostValue = readHost();
    return params.projectGrouping === "project"
      ? groupCatalogSessionsByProject(readHostValue.sessions)
      : params.projectGrouping === "person"
        ? groupCatalogSessionsByPerson(readHostValue.sessions)
        : null;
  });
  function CatalogRows(rowProps: {
    sessions: readonly SessionCatalogSession[];
    sectionId: string;
    projectChild?: boolean;
  }) {
    const expanded = () =>
      (params.visibleSessionLimits.get(rowProps.sectionId) ?? CATALOG_SESSION_GROUP_LIMIT) >
      CATALOG_SESSION_GROUP_LIMIT;
    return (
      <For
        each={
          expanded() ? rowProps.sessions : rowProps.sessions.slice(0, CATALOG_SESSION_GROUP_LIMIT)
        }
        keyed={(session) =>
          buildCatalogSessionKey({
            catalogId: readCatalog().id,
            hostId: readHost().hostId,
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
      (params.visibleSessionLimits.get(pageProps.sectionId) ?? CATALOG_SESSION_GROUP_LIMIT) >
      CATALOG_SESSION_GROUP_LIMIT;
    const label = () => (expanded() ? t("chat.messages.showLess") : t("chat.messages.showMore"));
    return (
      <Show when={pageProps.sessions.length > CATALOG_SESSION_GROUP_LIMIT}>
        <div class="sidebar-session-pagination sidebar-session-pagination--catalog">
          <button
            type="button"
            class="sidebar-session-pagination__button"
            aria-label={label()}
            onClick={() =>
              params.onSetVisibleSessionLimit(
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
      ? `catalog-${params.projectGrouping}-ungrouped:${readCatalogValue.id}:${readHostValue.hostId}`
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
            class={`sidebar-session-catalog-host__count ${readHost().error ? "sidebar-session-catalog-host__count--error" : ""}`}
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
              const sectionId = `catalog-${group().kind}:${readCatalog().id}:${readHost().hostId}:${group().key}`;
              const legacySectionId = createMemo(() =>
                group().legacySectionKey
                  ? `catalog-project:${readCatalog().id}:${readHost().hostId}:${group().legacySectionKey}`
                  : null,
              );
              const collapsedSectionId = createMemo(() => {
                const legacyId = legacySectionId();
                return params.collapsedSections.has(sectionId)
                  ? sectionId
                  : legacyId && params.collapsedSections.has(legacyId)
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
                    onClick={() => params.onToggleSection(collapsedSectionId() ?? sectionId)}
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
                          sectionId={sectionId}
                          projectChild
                        />
                      </div>
                      <CatalogPagination sessions={group().sessions} sectionId={sectionId} />
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
  const sectionId = `catalog:${readCatalog().id}`;
  const collapsed = createMemo(() => params.collapsedSections.has(sectionId));
  const rows = createMemo(() => readCatalog().visibleHosts.flatMap((host) => host.sessions));
  const liveRows = createMemo(() => {
    const rowsValue = rows();
    const readLiveRowsByKeyValue = readLiveRowsByKey();
    return rowsValue.flatMap((session) => {
      const row = session.sessionKey ? readLiveRowsByKeyValue.get(session.sessionKey) : undefined;
      return row ? [row] : [];
    });
  });
  const hasActiveRun = createMemo(() => liveRows().some(isSessionRunActive));
  const hasUnread = createMemo(() => liveRows().some((row) => row.unread === true));
  const hasBrandIcon = createMemo(() => hasProviderBrandIcon(readCatalog().id));
  const loadingMore = createMemo(() => params.loadingMoreCatalogIds.has(readCatalog().id));
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
  const sectionClass = createMemo(() => {
    const collapsedValue = collapsed();
    return [
      "sidebar-recent-sessions__group",
      "sidebar-recent-sessions__group--zone-coding",
      collapsedValue ? "sidebar-recent-sessions__group--collapsed" : "",
      params.draggingSectionId === sectionId ? "sidebar-recent-sessions__group--dragging" : "",
      params.sectionDropTarget?.sectionId === sectionId
        ? `sidebar-recent-sessions__group--section-drop-${params.sectionDropTarget.position}`
        : "",
    ]
      .filter(Boolean)
      .join(" ");
  });
  return (
    <div
      class={sectionClass()}
      data-session-section={sectionId}
      onDragOver={
        params.sectionDragDisabledReason
          ? undefined
          : (event: DragEvent) => params.onSectionDragOver(event, sectionId)
      }
      onDragLeave={
        params.sectionDragDisabledReason
          ? undefined
          : (event: DragEvent) => params.onSectionDragLeave(event, sectionId)
      }
      onDrop={
        params.sectionDragDisabledReason
          ? undefined
          : (event: DragEvent) => params.onSectionDrop(event, sectionId)
      }
    >
      {renderSidebarSessionSectionHeader({
        get sectionId() {
          return sectionId;
        },
        get status() {
          return hasError() || (collapsed() && rows().length > 0)
            ? {
                label: hasError() ? `${readCatalog().label}: ${errorHelp()}` : readCatalog().label,
                expanded: !collapsed(),
                title: hasError() ? errorHelp() : undefined,
                onToggle: () => params.onToggleSection(sectionId),
                content: (
                  <span
                    class={`sidebar-session-group-count ${hasError() ? "sidebar-session-group-count--error" : ""}`}
                    data-session-catalog-error={hasError() ? readCatalog().id : undefined}
                    aria-hidden="true"
                  >
                    {hasError() ? <Icon name="alertTriangle" /> : rows().length}
                  </span>
                ),
              }
            : undefined;
        },
        get disabledReason() {
          return params.sectionDragDisabledReason;
        },
        get onStartDrag() {
          return params.onStartSectionDrag;
        },
        get onFinishDrag() {
          return params.onFinishSectionDrag;
        },
        get reorder() {
          return {
            label: readCatalog().label,
            onMove: (target: string, position: "before" | "after") =>
              params.onReorderSection(sectionId, target, position),
          };
        },
        onContextMenu: (event) => {
          event.preventDefault();
          const header = event.currentTarget;
          const trigger =
            header.querySelector<HTMLElement>("[data-session-catalog-view-menu]") ?? header;
          params.onOpenViewMenu(readCatalog().id, trigger, {
            x: event.clientX,
            y: event.clientY,
          });
        },
        get content() {
          return (
            <>
              <button
                type="button"
                class="sidebar-session-group-toggle"
                aria-expanded={collapsed() ? "false" : "true"}
                aria-label={
                  hasError() ? `${readCatalog().label}: ${errorHelp()}` : readCatalog().label
                }
                title={hasError() ? errorHelp() : undefined}
                onClick={() => params.onToggleSection(sectionId)}
              >
                <span
                  class={`sidebar-session-group-toggle__lead ${hasBrandIcon() ? "sidebar-session-group-toggle__lead--branded" : ""}`}
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
                {renderCatalogHeaderStatus(hasActiveRun(), hasUnread())}
              </button>
              <button
                type="button"
                class={`sidebar-session-group-actions sidebar-session-sort sidebar-session-catalog-grouping ${params.ownerFilterActive ? "sidebar-session-sort--filtered" : ""}`}
                data-session-catalog-view-menu={readCatalog().id}
                title={t("chat.sidebar.catalogViewOptions")}
                aria-label={t("chat.sidebar.catalogViewOptions")}
                aria-haspopup="menu"
                aria-expanded={params.viewMenuOpenCatalogId === readCatalog().id ? "true" : "false"}
                onClick={(event) => {
                  event.stopPropagation();
                  params.onOpenViewMenu(readCatalog().id, event.currentTarget);
                }}
              >
                <Icon name="listFilter" />
              </button>
              {canCreateSession()
                ? renderNewSessionLink({
                    get basePath() {
                      return params.basePath;
                    },
                    get agentId() {
                      return params.newSessionAgentId;
                    },
                    get target() {
                      return {
                        catalogId: readCatalog().id,
                      };
                    },
                    get className() {
                      return "sidebar-session-group-actions sidebar-session-new sidebar-session-catalog-new";
                    },
                    get label() {
                      return `${t("chat.runControls.newSession")} — ${readCatalog().label}`;
                    },
                    get disabledReason() {
                      return params.newSessionDisabledReason;
                    },
                    get onOpen() {
                      return params.onOpenNewSession;
                    },
                  })
                : undefined}
            </>
          );
        },
      })}
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
              onClick={() => params.onLoadMore(readCatalog().id)}
            >
              {t("chat.selectors.loadMoreSessions")}
            </button>
          ) : undefined}
        </>
      )}
    </div>
  );
}
