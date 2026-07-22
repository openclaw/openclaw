import { html, nothing, type TemplateResult } from "lit";
import type { SessionCatalog } from "../../../packages/gateway-protocol/src/index.ts";
import type { GatewaySessionRow } from "../api/types.ts";
import { titleForRoute } from "../app-navigation.ts";
import type { CatalogOpenTarget } from "../app/settings.ts";
import { t } from "../i18n/index.ts";
import type { CatalogProjectGrouping } from "../lib/sessions/catalog-project-grouping.ts";
import { openCatalogSessionInTerminal } from "../lib/sessions/catalog-terminal.ts";
import { writeSessionGroupDragData } from "../lib/sessions/drag.ts";
import type { SidebarSessionSection } from "../lib/sessions/grouping.ts";
import { renderSessionCatalogGroups } from "./app-sidebar-session-catalogs.ts";
import {
  renderRecentSession,
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
  const totalRowCount = section.totalRowCount;
  const group = section.category;
  // zonedVisibleSections removes pinned rows; AppSidebar renders them through
  // renderPinnedSidebarSession, so every section here has a header.
  const collapsed = data.collapsed.has(section.id);
  const label = section.groups
    ? t("chat.sidebar.groups")
    : section.work
      ? t("chat.sidebar.coding")
      : group
        ? group
        : t("chat.sidebar.threads");
  const zone = section.groups ? "groups" : section.work ? "coding" : group ? "category" : "threads";
  // Collapsed Coding still signals live runs so background work stays visible.
  const collapsedRunningDot =
    collapsed &&
    section.work &&
    section.rows.some((row) => rowDemandsVisibility(row, RowVisibilityReason.ActiveRun));
  const collapsedAttentionDot =
    collapsed &&
    section.rows.some((row) => rowDemandsVisibility(row, RowVisibilityReason.Attention));
  const acceptsSessions =
    data.grouping === "category" && (section.id === "ungrouped" || Boolean(group));
  const sectionClass = [
    "sidebar-recent-sessions__group",
    `sidebar-recent-sessions__group--zone-${zone}`,
    collapsed ? "sidebar-recent-sessions__group--collapsed" : "",
    group && data.dragGroup === group ? "sidebar-recent-sessions__group--dragging" : "",
    data.drop === section.id ? "sidebar-recent-sessions__group--session-drop" : "",
    group && data.gDrop?.group === group
      ? `sidebar-recent-sessions__group--group-drop-${data.gDrop.position}`
      : "",
  ]
    .filter(Boolean)
    .join(" ");
  return html`
    <div
      class=${sectionClass}
      data-session-section=${section.id}
      @dragover=${acceptsSessions || group
        ? (event: DragEvent) => callbacks.sectionOver(event, section.id, group)
        : nothing}
      @dragleave=${acceptsSessions || group
        ? (event: DragEvent) => callbacks.sectionLeave(event, section.id, group)
        : nothing}
      @drop=${acceptsSessions || group
        ? (event: DragEvent) => callbacks.sectionDrop(event, section.id, group)
        : nothing}
    >
      ${html`
        <div
          class="sidebar-recent-sessions__head ${group
            ? "sidebar-recent-sessions__head--draggable"
            : ""}"
          draggable=${group ? "true" : "false"}
          @dragstart=${group
            ? (event: DragEvent) => {
                if (event.dataTransfer) {
                  writeSessionGroupDragData(event.dataTransfer, group);
                  callbacks.groupStart(group);
                }
              }
            : nothing}
          @dragend=${group
            ? () => {
                callbacks.groupEnd();
              }
            : nothing}
          @contextmenu=${group
            ? (event: MouseEvent) => {
                event.preventDefault();
                callbacks.groupMenu(group, event.clientX, event.clientY, null);
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
            @click=${() => callbacks.section(section.id)}
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
                  aria-expanded=${String(data.sort)}
                  @click=${(event: MouseEvent) => {
                    event.stopPropagation();
                    callbacks.sort(event.currentTarget as HTMLElement);
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
                    callbacks.newSession();
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
                  aria-expanded=${String(data.gMenu === group)}
                  @click=${(event: MouseEvent) => {
                    event.stopPropagation();
                    const trigger = event.currentTarget as HTMLElement;
                    const rect = trigger.getBoundingClientRect();
                    callbacks.groupMenu(group, rect.right, rect.bottom + 4, trigger);
                  }}
                >
                  ${icons.moreHorizontal}
                </button>
              `
            : nothing}
        </div>
      `}
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
  const { callbacks } = context;
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
              callbacks.setLimit(visible + SIDEBAR_SESSION_PAGE_SIZE);
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
              callbacks.clear();
              callbacks.setLimit(SIDEBAR_SESSION_PAGE_SIZE);
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
  const { callbacks } = context;
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
      renderRecentSession({
        context,
        session: snapshot.sidebarRowsByKey.get(row.key)!,
        display,
      }),
    onToggleSection: (sectionId) => callbacks.section(sectionId),
    onToggleProjectGrouping: () => callbacks.catalogGroup(),
    onLoadMore: (catalogId) => void callbacks.more(catalogId),
    onOpenNewSession: callbacks.newTarget,
    onNavigate: callbacks.navigate,
    catalogOpenTarget: snapshot.catalogOpenTarget,
    terminalAvailable: snapshot.terminalAvailable,
    onOpenTerminal: openCatalogSessionInTerminal,
    onOpenMenu: (request, x, y, trigger) => callbacks.catalog(request, x, y, trigger),
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
  const { data } = context;
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
        data.status === "active" &&
        data.drag === null
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
  creatorFilter: TemplateResult | typeof nothing;
  catalogs: SessionCatalogRenderSnapshot;
}) {
  const { context } = params;
  const { data, callbacks } = context;
  return html`
    <section
      class="sidebar-sessions ${data.remove ? "sidebar-sessions--removal-drop" : ""}"
      @dragover=${(event: DragEvent) => callbacks.listDragOver(event)}
      @dragleave=${(event: DragEvent) => callbacks.listDragLeave(event)}
      @drop=${(event: DragEvent) => callbacks.listDrop(event)}
    >
      ${data.error
        ? html`
            <div
              class="sidebar-session-error callout danger callout--dismissible"
              role="alert"
              data-sidebar-session-error
            >
              <span class="callout__content">${data.error}</span>
              <openclaw-tooltip .content=${t("chat.actions.dismissError")}>
                <button
                  class="callout__dismiss"
                  type="button"
                  @click=${() => callbacks.dismissError()}
                  aria-label=${t("chat.actions.dismissError")}
                >
                  ${icons.x}
                </button>
              </openclaw-tooltip>
            </div>
          `
        : nothing}
      <div class="sidebar-recent-sessions" aria-label=${titleForRoute("sessions")}>
        ${params.creatorFilter}
        ${renderSessionListBody({
          context,
          sections: params.sections,
          expandedRows: params.expandedRows,
          visibleRowCount: params.visibleRowCount,
          showDraft: params.showDraft,
          codingTrailing:
            data.status === "archived"
              ? nothing
              : html`${renderSessionCatalogs({ context, snapshot: params.catalogs })}`,
          codingTrailingPresent: data.status !== "archived" && params.catalogs.catalogs.length > 0,
        })}
        ${data.status === "archived" && params.visibleSessions.length === 0
          ? html`<span class="sidebar-session-empty-hint"
              >${t("sessionsView.noArchivedSessions")}</span
            >`
          : nothing}
      </div>
    </section>
  `;
}
