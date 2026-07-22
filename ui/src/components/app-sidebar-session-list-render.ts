import { html, nothing, type TemplateResult } from "lit";
import type { SessionCatalog } from "../../../packages/gateway-protocol/src/index.ts";
import type { GatewaySessionRow } from "../api/types.ts";
import { titleForRoute } from "../app-navigation.ts";
import type { CatalogOpenTarget } from "../app/settings.ts";
import { t } from "../i18n/index.ts";
import type { CatalogProjectGrouping } from "../lib/sessions/catalog-project-grouping.ts";
import { writeSessionGroupDragData } from "../lib/sessions/drag.ts";
import { sidebarSectionHasHeader, type SidebarSessionSection } from "../lib/sessions/grouping.ts";
import { renderSessionCatalogGroups } from "./app-sidebar-session-catalogs.ts";
import {
  renderCatalogBackingSession,
  renderSessionTree,
  type SessionListRenderContext,
} from "./app-sidebar-session-row-render.ts";
import {
  limitSidebarSessionRows,
  rowDemandsVisibility,
  RowVisibilityReason,
  SIDEBAR_SESSION_PAGE_SIZE,
  SIDEBAR_SESSION_SEE_LESS_THRESHOLD,
  type SidebarRecentSession,
} from "./app-sidebar-session-types.ts";
import { icons } from "./icons.ts";
import { renderSessionCreatorFilter } from "./session-owner-chip.ts";

type RenderableSessionSection = SidebarSessionSection<SidebarRecentSession> & {
  totalRowCount: number;
};

type SessionCatalogRenderSnapshot = {
  catalogs: readonly SessionCatalog[];
  connected: boolean;
  basePath: string;
  routeSessionKey: string;
  newSessionAgentId: string;
  collapsedSections: ReadonlySet<string>;
  loadingMoreCatalogIds: ReadonlySet<string>;
  projectGrouping: CatalogProjectGrouping;
  liveRows: readonly GatewaySessionRow[];
  sidebarRowsByKey: ReadonlyMap<string, SidebarRecentSession>;
  creatorId: string | null;
  catalogOpenTarget: CatalogOpenTarget;
  terminalAvailable: boolean;
};

function renderSessionSection(params: {
  context: SessionListRenderContext;
  section: RenderableSessionSection;
  trailing?: TemplateResult | typeof nothing;
  showDraft?: boolean;
}) {
  const { context, section } = params;
  const { data, callbacks } = context;
  const trailing = params.trailing ?? nothing;
  const showDraft = params.showDraft ?? false;
  const totalRowCount = section.totalRowCount ?? section.rows.length;
  const group = section.category;
  const isPinned = section.id === "pinned";
  const showHeader = sidebarSectionHasHeader(section.id, data.sessionsGrouping);
  const collapsed = showHeader && data.collapsedSessionSections.has(section.id);
  const label = isPinned
    ? t("sessionsView.pinned")
    : section.groups
      ? t("chat.sidebar.groups")
      : section.work
        ? t("chat.sidebar.coding")
        : group
          ? group
          : t("chat.sidebar.threads");
  const zone = isPinned
    ? "pinned"
    : section.groups
      ? "groups"
      : section.work
        ? "coding"
        : group
          ? "category"
          : "threads";
  // Collapsed Coding still signals live runs so background work stays visible.
  const collapsedRunningDot =
    collapsed &&
    section.work &&
    section.rows.some((row) => rowDemandsVisibility(row, RowVisibilityReason.ActiveRun));
  const collapsedAttentionDot =
    collapsed &&
    section.rows.some((row) => rowDemandsVisibility(row, RowVisibilityReason.Attention));
  const acceptsSessions =
    isPinned ||
    (data.sessionsGrouping === "category" && (section.id === "ungrouped" || Boolean(group)));
  const sectionClass = [
    "sidebar-recent-sessions__group",
    `sidebar-recent-sessions__group--zone-${zone}`,
    collapsed ? "sidebar-recent-sessions__group--collapsed" : "",
    group && data.draggingSessionGroup === group ? "sidebar-recent-sessions__group--dragging" : "",
    data.sessionDropTarget === section.id ? "sidebar-recent-sessions__group--session-drop" : "",
    group && data.sessionGroupDropTarget?.group === group
      ? `sidebar-recent-sessions__group--group-drop-${data.sessionGroupDropTarget.position}`
      : "",
  ]
    .filter(Boolean)
    .join(" ");
  return html`
    <div
      class=${sectionClass}
      data-session-section=${section.id}
      @dragover=${acceptsSessions || group
        ? (event: DragEvent) => callbacks.handleSessionSectionDragOver(event, section.id, group)
        : nothing}
      @dragleave=${acceptsSessions || group
        ? (event: DragEvent) => callbacks.handleSessionSectionDragLeave(event, section.id, group)
        : nothing}
      @drop=${acceptsSessions || group
        ? (event: DragEvent) => callbacks.handleSessionSectionDrop(event, section.id, group)
        : nothing}
    >
      ${showHeader
        ? html`
            <div
              class="sidebar-recent-sessions__head ${group
                ? "sidebar-recent-sessions__head--draggable"
                : ""}"
              draggable=${group ? "true" : "false"}
              @dragstart=${group
                ? (event: DragEvent) => {
                    if (event.dataTransfer) {
                      writeSessionGroupDragData(event.dataTransfer, group);
                      callbacks.startSessionGroupDrag(group);
                    }
                  }
                : nothing}
              @dragend=${group
                ? () => {
                    callbacks.finishSessionGroupDrag();
                  }
                : nothing}
              @contextmenu=${group
                ? (event: MouseEvent) => {
                    event.preventDefault();
                    callbacks.openSessionGroupMenu(group, event.clientX, event.clientY, null);
                  }
                : nothing}
            >
              ${group
                ? html`<span class="sidebar-session-group-drag-handle" aria-hidden="true"></span>`
                : nothing}
              <button
                type="button"
                class="sidebar-session-group-toggle"
                aria-expanded=${String(!collapsed)}
                aria-label=${label}
                @click=${() => callbacks.toggleSessionSection(section.id)}
              >
                <span class="sidebar-recent-sessions__label-text">${label}</span>
                <span class="sidebar-session-group-toggle__icon" aria-hidden="true"
                  >${collapsed ? icons.chevronRight : icons.chevronDown}</span
                >
                ${collapsed && totalRowCount > 0
                  ? html`<span class="sidebar-session-group-count">${totalRowCount}</span>`
                  : nothing}
                ${collapsedRunningDot
                  ? html`<span
                      class="session-run-spinner sidebar-session-group-running"
                      role="img"
                      aria-label=${t("sessionsView.activeRun")}
                      title=${t("sessionsView.activeRun")}
                    ></span>`
                  : nothing}
                ${collapsedAttentionDot
                  ? html`<span
                      class="sidebar-session-group-attention"
                      role="img"
                      aria-label=${t("sessionsView.attentionRequired")}
                      title=${t("sessionsView.attentionRequired")}
                    ></span>`
                  : nothing}
              </button>
              ${section.id === "ungrouped"
                ? html`
                    <button
                      type="button"
                      class="sidebar-session-group-actions sidebar-session-sort"
                      title=${t("chat.sidebar.sortSessions")}
                      aria-label=${t("chat.sidebar.sortSessions")}
                      aria-haspopup="menu"
                      aria-expanded=${String(data.sessionSortMenuOpen)}
                      @click=${(event: MouseEvent) => {
                        event.stopPropagation();
                        callbacks.toggleSessionSortMenu(event.currentTarget as HTMLElement);
                      }}
                    >
                      ${icons.listFilter}
                    </button>
                    <button
                      type="button"
                      class="sidebar-session-group-actions sidebar-new-session"
                      title=${data.connected
                        ? t("chat.runControls.newSession")
                        : t("chat.runControls.newSessionDisconnected")}
                      aria-label=${t("chat.runControls.newSession")}
                      ?disabled=${!data.connected}
                      @click=${(event: MouseEvent) => {
                        event.stopPropagation();
                        callbacks.openNewSessionForExpandedAgent();
                      }}
                    >
                      ${icons.plus}
                    </button>
                  `
                : nothing}
              ${group
                ? html`
                    <button
                      type="button"
                      class="sidebar-session-group-actions"
                      title=${t("sessionsView.groupMenu", { group })}
                      aria-label=${t("sessionsView.groupMenu", { group })}
                      aria-haspopup="menu"
                      aria-expanded=${String(data.sessionGroupMenuGroup === group)}
                      @click=${(event: MouseEvent) => {
                        event.stopPropagation();
                        const trigger = event.currentTarget as HTMLElement;
                        const rect = trigger.getBoundingClientRect();
                        callbacks.openSessionGroupMenu(group, rect.right, rect.bottom + 4, trigger);
                      }}
                    >
                      ${icons.moreHorizontal}
                    </button>
                  `
                : nothing}
            </div>
          `
        : nothing}
      ${collapsed
        ? nothing
        : html`
            ${section.rows.length > 0 || showDraft
              ? html`<div class="sidebar-recent-sessions__list" role="list" aria-label=${label}>
                  ${showDraft ? renderDraftSessionRow() : nothing}
                  ${section.rows.map((session) => renderSessionTree({ context, session }))}
                </div>`
              : nothing}
            ${trailing}
          `}
    </div>
  `;
}

function renderDraftSessionRow() {
  return html`
    <div class="sidebar-recent-session sidebar-recent-session--draft">
      <span class="sidebar-recent-session__link">
        <span class="sidebar-session-indicator" aria-hidden="true">
          <span class="sidebar-session-indicator__dot"></span>
        </span>
        <span class="sidebar-recent-session__text">
          <span class="sidebar-recent-session__name">${t("newSession.draftRow")}</span>
        </span>
      </span>
    </div>
  `;
}

function renderSessionPagination(params: {
  context: SessionListRenderContext;
  rows: SidebarRecentSession[];
  visible: number;
}) {
  const { context, rows, visible } = params;
  const canShowMore = visible < rows.length;
  const collapsedVisible = limitSidebarSessionRows(rows, SIDEBAR_SESSION_PAGE_SIZE).length;
  const canShowLess = visible > SIDEBAR_SESSION_SEE_LESS_THRESHOLD && visible > collapsedVisible;
  if (!canShowMore && !canShowLess) {
    return nothing;
  }
  return html`
    <div class="sidebar-session-pagination">
      ${canShowMore
        ? html`<button
            type="button"
            class="sidebar-session-pagination__button"
            aria-label=${t("chat.selectors.loadMoreSessions")}
            @click=${() => {
              context.callbacks.setVisibleSessionLimit(visible + SIDEBAR_SESSION_PAGE_SIZE);
            }}
          >
            ${t("chat.selectors.loadMoreSessions")}
          </button>`
        : nothing}
      ${canShowLess
        ? html`<button
            type="button"
            class="sidebar-session-pagination__button"
            aria-label=${t("usage.details.collapse")}
            @click=${() => {
              context.callbacks.clearSessionSelection();
              context.callbacks.setVisibleSessionLimit(SIDEBAR_SESSION_PAGE_SIZE);
            }}
          >
            ${t("usage.details.collapse")}
          </button>`
        : nothing}
    </div>
  `;
}

function renderSessionCatalogs(params: {
  context: SessionListRenderContext;
  snapshot: SessionCatalogRenderSnapshot;
}) {
  const { context, snapshot } = params;
  return renderSessionCatalogGroups({
    catalogs: snapshot.catalogs,
    connected: snapshot.connected,
    basePath: snapshot.basePath,
    routeSessionKey: snapshot.routeSessionKey,
    newSessionAgentId: snapshot.newSessionAgentId,
    collapsedSections: snapshot.collapsedSections,
    loadingMoreCatalogIds: snapshot.loadingMoreCatalogIds,
    projectGrouping: snapshot.projectGrouping,
    liveRows: snapshot.liveRows,
    creatorId: snapshot.creatorId,
    renderLiveRow: (row, display) =>
      renderCatalogBackingSession({
        context,
        session: snapshot.sidebarRowsByKey.get(row.key)!,
        display,
      }),
    onToggleSection: (sectionId) => context.callbacks.toggleSessionSection(sectionId),
    onToggleProjectGrouping: () => context.callbacks.toggleCatalogProjectGrouping(),
    onLoadMore: (catalogId) => context.callbacks.loadMoreSessionCatalog(catalogId),
    onOpenNewSession: context.callbacks.onOpenNewSession,
    onNavigate: context.callbacks.onNavigate,
    catalogOpenTarget: snapshot.catalogOpenTarget,
    terminalAvailable: snapshot.terminalAvailable,
    onOpenTerminal: (key) => context.callbacks.openCatalogSessionInTerminal(key),
    onOpenMenu: (request, x, y, trigger) =>
      context.callbacks.openCatalogSessionMenu(request, x, y, trigger),
  });
}

function renderSessionListBody(params: {
  context: SessionListRenderContext;
  sections: RenderableSessionSection[];
  expandedRows: SidebarRecentSession[];
  visibleRowCount: number;
  showDraft: boolean;
  codingTrailing?: TemplateResult | typeof nothing;
  codingTrailingPresent?: boolean;
}) {
  const { context } = params;
  return html`
    ${params.sections.map((section) => {
      const showDraft = section.id === "ungrouped" && params.showDraft;
      if (section.id === "work") {
        // Coding hosts live work/ACP rows plus the CLI catalogs; hide the
        // whole zone when both are empty.
        if (section.totalRowCount === 0 && params.codingTrailingPresent !== true) {
          return nothing;
        }
        return renderSessionSection({
          context,
          section,
          trailing: params.codingTrailing ?? nothing,
        });
      }
      // Threads hides its bare empty header; unfiltered custom categories stay
      // visible because creation and drag flows depend on them as drop targets.
      if (
        section.id === "ungrouped" &&
        section.totalRowCount === 0 &&
        !showDraft &&
        context.data.sessionsStatusFilter === "active" &&
        context.data.draggingSessionKey === null
      ) {
        return nothing;
      }
      return renderSessionSection({ context, section, showDraft });
    })}
    ${renderSessionPagination({
      context,
      rows: params.expandedRows,
      visible: params.visibleRowCount,
    })}
  `;
}

export function renderSessionList(params: {
  context: SessionListRenderContext;
  visibleSessions: SidebarRecentSession[];
  sections: RenderableSessionSection[];
  expandedRows: SidebarRecentSession[];
  visibleRowCount: number;
  showDraft: boolean;
  catalogs: SessionCatalogRenderSnapshot;
}) {
  const { context } = params;
  return html`
    <section
      class="sidebar-sessions ${context.data.sessionListRemovalDrop
        ? "sidebar-sessions--removal-drop"
        : ""}"
      @dragover=${(event: DragEvent) => context.callbacks.handleSessionListDragOver(event)}
      @dragleave=${(event: DragEvent) => context.callbacks.handleSessionListDragLeave(event)}
      @drop=${(event: DragEvent) => context.callbacks.handleSessionListDrop(event)}
    >
      ${context.data.sessionMutationError
        ? html`
            <div
              class="sidebar-session-error callout danger callout--dismissible"
              role="alert"
              data-sidebar-session-error
            >
              <span class="callout__content">${context.data.sessionMutationError}</span>
              <openclaw-tooltip .content=${t("chat.actions.dismissError")}>
                <button
                  class="callout__dismiss"
                  type="button"
                  @click=${() => context.callbacks.dismissSessionMutationError()}
                  aria-label=${t("chat.actions.dismissError")}
                >
                  ${icons.x}
                </button>
              </openclaw-tooltip>
            </div>
          `
        : nothing}
      <div class="sidebar-recent-sessions" aria-label=${titleForRoute("sessions")}>
        ${renderSessionCreatorFilter({
          creators: context.data.sessionCreatorOptions,
          selectedId: context.data.sessionCreatorFilterId,
          onChange: (creatorId) => context.callbacks.changeSessionCreatorFilter(creatorId),
        })}
        ${renderSessionListBody({
          context,
          sections: params.sections,
          expandedRows: params.expandedRows,
          visibleRowCount: params.visibleRowCount,
          showDraft: params.showDraft,
          codingTrailing:
            context.data.sessionsStatusFilter === "archived"
              ? nothing
              : html`${renderSessionCatalogs({ context, snapshot: params.catalogs })}`,
          codingTrailingPresent:
            context.data.sessionsStatusFilter !== "archived" && params.catalogs.catalogs.length > 0,
        })}
        ${context.data.sessionsStatusFilter === "archived" && params.visibleSessions.length === 0
          ? html`<span class="sidebar-session-empty-hint"
              >${t("sessionsView.noArchivedSessions")}</span
            >`
          : nothing}
      </div>
    </section>
  `;
}
