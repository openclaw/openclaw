import type { JSX } from "@solidjs/web";
import { createEffect, createMemo, For, Show } from "solid-js";
import type { SessionObserverDigest } from "../../../packages/gateway-protocol/src/schema/sessions.js";
import { normalizeSessionColorValue } from "../../../packages/gateway-protocol/src/session-agent-status.js";
import type { GatewaySessionRow } from "../api/types.ts";
import type { NavigationRouteId } from "../app-navigation.ts";
import type { ApplicationContext, ApplicationNavigationOptions } from "../app/context.ts";
import { handleContextMenuEvent } from "../lib/keyboard-shortcuts.ts";
import { t } from "../lib/reactive/i18n.ts";
import type {
  SessionMethodAccess,
  SessionMethodAccessRequest,
} from "../lib/session-method-access.ts";
import { writeSessionDragData } from "../lib/sessions/drag.ts";
import type { SidebarSessionsGrouping } from "../lib/sessions/grouping.ts";
import { canArchiveSessionRow, resolveUiConfiguredMainKey } from "../lib/sessions/session-key.ts";
import { renderHoverMarquee } from "../lib/solid/hover-marquee.tsx";
import type { NewSessionTarget } from "../pages/new-session/location.ts";
import type {
  CatalogBackingSessionDisplay,
  CatalogSessionMenuRequest,
} from "./app-sidebar-session-catalogs.ts";
import { renderSidebarSessionIndicators } from "./app-sidebar-session-indicators.tsx";
import type { SessionPullRequestIndicatorsController } from "./app-sidebar-session-pr-indicators.ts";
import type { SidebarSessionProjection } from "./app-sidebar-session-projection.ts";
import type {
  SidebarRecentSession,
  SidebarToolActivity,
  SidebarSessionStatusFilter,
} from "./app-sidebar-session-types.ts";
import { rowDemandsVisibility } from "./app-sidebar-session-types.ts";
import type { SessionDataController } from "./session-data-controller.ts";
import type { SessionOrganizerController } from "./session-organizer-controller.ts";
import type { SessionOwnerOption } from "./session-owner-chip.ts";
import { resolveSidebarSessionRowSubtitle } from "./session-row-subtitle.ts";
import type { SidebarMenusController } from "./sidebar-menus-controller.tsx";
import { Icon } from "./solid/icon.tsx";
import { renderSidebarSessionSubtitle } from "./solid/session-presentation.tsx";
import "./elapsed-time.ts";
import "./tooltip.ts";
const SIDEBAR_VISIBLE_CHILD_SESSION_LIMIT = 4;
export interface SessionListHost {
  readonly sidebarSnapshot?: import("./sidebar-snapshot-model.ts").SidebarSnapshotModel | null;
  readonly sidebarAgentsMode?: "chip" | "roster";
  readonly basePath: string;
  readonly sessionDataContext:
    | Pick<ApplicationContext, "gateway" | "agentSelection" | "agents" | "sessions">
    | undefined;
  readonly sidebarLiveActivity: boolean;
  readonly sessionsShowCron: boolean;
  readonly sessionsShowPreview: boolean;
  readonly sessionsShowSystem: boolean;
  readonly sidebarNarrationLines: ReadonlyMap<string, string>;
  readonly sidebarTools: ReadonlyMap<string, SidebarToolActivity>;
  readonly sidebarObserverDigests: ReadonlyMap<string, SessionObserverDigest>;
  readonly sessionProjection: Pick<SidebarSessionProjection, "resolveSubtitle">;
  readonly selectedSessionKeys: ReadonlySet<string>;
  readonly connected: boolean;
  readonly sessionData: Pick<
    SessionDataController,
    | "childSessionErrorsByParent"
    | "dismissSessionMutationError"
    | "loadMoreSessionCatalog"
    | "loadMoreSidebarSessions"
    | "presenceInstanceId"
    | "presencePayload"
    | "refreshSessionCatalogs"
    | "retryChildSessions"
    | "sessionCatalogRefreshStatus"
    | "sessionMutationError"
    | "visibleSessionLimits"
  >;
  readonly sessionsGrouping: SidebarSessionsGrouping;
  readonly collapsedSessionSections: ReadonlySet<string>;
  readonly sessionOrganizer: Pick<
    SessionOrganizerController,
    | "draggingSidebarSection"
    | "draggingSessionKey"
    | "isDraggingChildSession"
    | "finishSessionDrag"
    | "finishSidebarSectionDrag"
    | "handleSessionListDragLeave"
    | "handleSessionListDragOver"
    | "handleSessionListDrop"
    | "sectionDragLeave"
    | "sectionDragOver"
    | "sectionDrop"
    | "sessionDropTarget"
    | "sidebarSectionDropTarget"
    | "sessionListRemovalDrop"
    | "setSessionsStatusFilter"
    | "startSessionDrag"
    | "startSidebarSectionDrag"
    | "archiveSessionWithUndo"
    | "patchSession"
    | "isPersonalSessionPin"
    | "reorderSidebarSection"
  >;
  readonly sidebarMenus: Pick<
    SidebarMenusController,
    | "catalogMenu"
    | "catalogViewMenuPosition"
    | "openCatalogViewMenu"
    | "openSessionGroupMenu"
    | "openSessionMenu"
    | "sessionGroupMenu"
    | "sessionMenu"
    | "sessionSortMenuPosition"
    | "toggleCatalogViewMenu"
    | "togglePositionedMenu"
  >;
  readonly sessionsStatusFilter: SidebarSessionStatusFilter;
  readonly sessionOwnerFilterActive: boolean;
  readonly sessionOwnerFilterId: string | null;
  readonly sessionInvolvingMeFilterActive: boolean;
  readonly sessionOwnerOptions: readonly SessionOwnerOption[];
  readonly sessionOwnershipVisibility: {
    filters: boolean;
    avatars: boolean;
  };
  readonly onOpenNewSession?: (agentId: string, target?: NewSessionTarget) => void;
  readonly onNavigate?: (
    routeId: NavigationRouteId,
    options?: ApplicationNavigationOptions,
  ) => void;
  readonly sessionPullRequests: Pick<SessionPullRequestIndicatorsController, "summary">;
  mainSessionRow(): GatewaySessionRow | null;
  setSessionOwnerFilter(ownerId: string | null, involvingMe?: boolean): void;
  isSessionChildrenExpanded(session: SidebarRecentSession): boolean;
  isSessionChildrenFullyShown(sessionKey: string): boolean;
  sidebarSessionHref(session: SidebarRecentSession): string;
  handleSessionRowClick(event: MouseEvent, session: SidebarRecentSession): void;
  toggleSessionChildren(session: SidebarRecentSession): void;
  toggleSessionPin(session: SidebarRecentSession): void;
  toggleSessionMenu(
    session: SidebarRecentSession,
    trigger: HTMLElement,
    catalogMenu?: CatalogSessionMenuRequest,
  ): void;
  showMoreChildren(sessionKey: string): void;
  toggleSection(sectionId: string): void;
  expandedAgentId(): string;
  readNewSessionAccess(): SessionMethodAccess;
  readSessionMutationAccess(request: SessionMethodAccessRequest): SessionMethodAccess;
  requestOpenNewSession(agentId: string, target?: NewSessionTarget): void;
  setVisibleSessionLimit(sectionId: string, limit: number): void;
  clearSessionSelection(): void;
}
export function visibleSessionChildren(params: {
  session: SidebarRecentSession;
  fullyShown: boolean;
}): readonly SidebarRecentSession[] {
  // Active, running, and attention-bearing branches must bypass the quiet-child cap.
  return params.fullyShown
    ? params.session.children
    : params.session.children.filter(
        (child, index) =>
          index < SIDEBAR_VISIBLE_CHILD_SESSION_LIMIT || rowDemandsVisibility(child),
      );
}

/** Compose independently owned session state and context indicators. */

type RecentSessionParams = {
  host: SessionListHost;
  session: SidebarRecentSession;
  display?: CatalogBackingSessionDisplay;
  listItem?: boolean;
  icon?: JSX.Element;
};
export function renderRecentSession(params: RecentSessionParams) {
  return (
    <Show when={params.session.key} keyed>
      {(_key) => renderRecentSessionRow(params)}
    </Show>
  );
}
function renderRecentSessionRow(params: RecentSessionParams) {
  const host = createMemo(() => params.host),
    session = createMemo(() => params.session, {
      equals: false,
    }),
    display = createMemo(() => params.display),
    listItem = createMemo(() => params.listItem ?? true),
    icon = createMemo(() => params.icon);
  const personallyPinned = createMemo(() =>
    host().sessionOrganizer.isPersonalSessionPin(session().key),
  );
  const archiveAccess = createMemo(() =>
    host().readSessionMutationAccess({
      method: "sessions.patch",
      params: {
        key: session().key,
        archived: !session().archived,
      },
      sessionScope: true,
      session: session(),
    }),
  );
  const archiveAllowed = createMemo(
    () =>
      session().archived ||
      canArchiveSessionRow(
        session(),
        resolveUiConfiguredMainKey({
          agentsList: host().sessionDataContext?.agents.state.agentsList,
          hello: host().sessionDataContext?.gateway.snapshot.hello,
        }),
      ),
  );
  const archiving = createMemo(
    () => host().sessionDataContext?.sessions.archiveVisibility(session().key) === "pending",
  );
  const team = createMemo(() => host().sidebarAgentsMode === "roster");
  const ownAttention = createMemo(() => session().ownAttention ?? session().attention);
  const label = createMemo(() => session().label);
  const subtitleState = createMemo(
    () =>
      (host().sidebarSnapshot ? session().snapshotSubtitle : undefined) ??
      resolveSidebarSessionRowSubtitle(host(), session(), display()),
  );
  const subtitle = createMemo(() => subtitleState().subtitle),
    narration = createMemo(() => subtitleState().narration),
    toolName = createMemo(() => subtitleState().toolName);
  const indicators = renderSidebarSessionIndicators(host(), session, display(), icon);
  const running = createMemo(() => indicators.running),
    stateId = createMemo(() => indicators.stateId),
    metaId = createMemo(() => indicators.metaId),
    pullRequest = createMemo(() => indicators.pullRequest),
    persistentIndicator = createMemo(() => indicators.persistentIndicator),
    childrenExpanded = createMemo(() => indicators.childrenExpanded);
  const openMenuFromEvent: JSX.EventHandler<HTMLDivElement, MouseEvent | KeyboardEvent> = (event) =>
    handleContextMenuEvent(
      event,
      event.currentTarget.querySelector<HTMLElement>(".sidebar-recent-session__link"),
      (trigger, x, y) => {
        if (display()?.catalogMenu) {
          host().sidebarMenus.catalogMenu.open(display().catalogMenu, x, y, trigger ?? undefined);
          return;
        }
        if (!host().sidebarSnapshot) {
          host().sidebarMenus.openSessionMenu(session(), x, y, trigger);
        }
      },
    );
  const pinLabel = createMemo(() => {
    return t(personallyPinned() ? "sessionsView.unpinSession" : "sessionsView.pinSession");
  });
  const archiveLabel = createMemo(() => {
    const sessionValue = session();
    return t(sessionValue.archived ? "sessionsView.restoreSession" : "sessionsView.archiveSession");
  });
  const menuOpen = createMemo(() => {
    const displayValue = display();
    const hostValue = host();
    const sessionValue = session();
    return displayValue?.catalogMenu
      ? hostValue.sidebarMenus.catalogMenu.isOpenFor(displayValue.catalogMenu.key)
      : hostValue.sidebarMenus.sessionMenu?.session.key === sessionValue.key;
  });
  const color = createMemo(() => normalizeSessionColorValue(session().color ?? ""));
  const rowClass = createMemo(() => {
    const teamValue = team();
    const colorValue = color();
    const sessionValue = session();
    const subtitleValue = subtitle();
    const hostValue = host();
    const runningValue = running();
    const ownAttentionValue = ownAttention();
    return [
      "sidebar-recent-session",
      "session-row-host",
      teamValue ? "sidebar-recent-session--team" : "",
      colorValue ? "sidebar-recent-session--colored" : "",
      sessionValue.isChild ? "sidebar-recent-session--child" : "",
      teamValue || (!subtitleValue && !sessionValue.channelPresentation)
        ? "sidebar-recent-session--single-line"
        : "",
      sessionValue.archived ? "sidebar-session--archived" : "",
      sessionValue.visuallyActive ? "sidebar-recent-session--active" : "",
      hostValue.selectedSessionKeys.has(sessionValue.key) ? "sidebar-recent-session--selected" : "",
      personallyPinned() ? "session-row-host--pinned" : "",
      runningValue ? "session-row-host--running" : "",
      sessionValue.visibility === "draft" ? "session-row-host--draft" : "",
      sessionValue.visibility === "draft"
        ? sessionValue.draftOwnedBySelf
          ? "session-row-host--draft-owner"
          : "session-row-host--draft-other"
        : "",
      (teamValue ? ownAttentionValue : sessionValue.attention).kind === "error"
        ? "sidebar-recent-session--attention-danger"
        : (teamValue ? ownAttentionValue : sessionValue.attention).kind !== "none" &&
            (teamValue ? ownAttentionValue : sessionValue.attention).kind !== "question"
          ? "sidebar-recent-session--attention-amber"
          : "",
      hostValue.sessionOrganizer.draggingSessionKey === sessionValue.key
        ? "sidebar-recent-session--dragging"
        : "",
    ]
      .filter(Boolean)
      .join(" ");
  });
  const groupWriteAccess = createMemo(() =>
    host().readSessionMutationAccess({
      method: "sessions.groups.put",
      requiredScope: "operator.write",
    }),
  );
  const rowDraggable = createMemo(() => groupWriteAccess().allowed);
  const marqueeLabelTemplate = createMemo(() => {
    const teamValue = team();
    const labelValue = label();
    return renderHoverMarquee(
      <>
        {teamValue ? undefined : indicators.originIndicators}
        {labelValue}
      </>,
      "sidebar-recent-session__name",
    );
  });
  const marqueeLabel = createMemo(() =>
    display() ? (
      <Show
        when={JSON.stringify([
          label(),
          session().archived === true,
          session().forkSource !== undefined,
          pullRequest(),
        ])}
        keyed
      >
        {() => marqueeLabelTemplate()}
      </Show>
    ) : (
      marqueeLabelTemplate()
    ),
  );
  // Always reserve the lead so every title shares the section-label text line.
  let rowElement: HTMLDivElement | undefined;
  createEffect(
    () => display()?.rowRef,
    (callback) => callback?.(rowElement),
  );
  const row = (
    <div
      ref={(element) => {
        rowElement = element;
      }}
      class={rowClass()}
      style={color() ? `--session-color: var(--session-color-${color()})` : undefined}
      data-session-key={session().key}
      data-catalog-session-key={display()?.catalogIdentityKey ?? undefined}
      role={listItem() ? "listitem" : undefined}
      draggable={rowDraggable() ? "true" : "false"}
      onDragStart={(event: DragEvent) => {
        if (!rowDraggable()) {
          event.preventDefault();
          return;
        }
        if (event.dataTransfer) {
          writeSessionDragData(event.dataTransfer, session().key);
          host().sessionOrganizer.startSessionDrag(session());
        }
      }}
      onDragEnd={() => host().sessionOrganizer.finishSessionDrag()}
      onContextMenu={openMenuFromEvent}
      onKeyDown={openMenuFromEvent}
    >
      <a
        href={host().sidebarSessionHref(session())}
        class="sidebar-recent-session__link"
        draggable="false"
        aria-current={session().visuallyActive ? "page" : undefined}
        aria-describedby={[stateId(), metaId()].filter(Boolean).join(" ") || undefined}
        onClick={(event: MouseEvent) => host().handleSessionRowClick(event, session())}
      >
        {persistentIndicator()}
        <span class="sidebar-recent-session__text">
          <span class="sidebar-recent-session__title-row">{marqueeLabel()}</span>
          <span class="sidebar-recent-session__details">
            {session().channelPresentation ? (
              <span class="sidebar-recent-session__channel">
                <span class="sr-only">
                  {t("sessionHovercard.linkedChannel", {
                    channel: session().channelPresentation.channelLabel,
                  })}
                </span>
                <span aria-hidden="true">{session().channelPresentation.channelLabel}</span>
              </span>
            ) : undefined}
            {team()
              ? undefined
              : renderSidebarSessionSubtitle({
                  get subtitle() {
                    return subtitle();
                  },
                  get narration() {
                    return narration();
                  },
                  get toolName() {
                    return toolName();
                  },
                })}
            {indicators.content}
          </span>
        </span>
      </a>
      {session().childSessionKeys.length > 0 ? (
        <button
          class={`sidebar-child-session-toggle ${!team() && session().runningChildCount > 0 ? "sidebar-child-session-toggle--running" : !team() && session().failedChildCount > 0 ? "sidebar-child-session-toggle--failed" : ""}`}
          type="button"
          data-child-session-toggle={session().key}
          aria-expanded={String(childrenExpanded())}
          aria-label={t(
            childrenExpanded()
              ? "sessionsView.hideChildSessions"
              : "sessionsView.showChildSessions",
            {
              count: String(session().childSessionKeys.length),
              session: label(),
            },
          )}
          aria-description={
            !team() && !childrenExpanded() && session().runningChildCount > 0
              ? t("sessionsView.activeRun")
              : undefined
          }
          onClick={() => host().toggleSessionChildren(session())}
        >
          <span class="sidebar-child-session-toggle__icon" aria-hidden="true">
            {childrenExpanded() ? <Icon name="chevronDown" /> : <Icon name="chevronRight" />}
          </span>
          {childrenExpanded() || team() ? undefined : (
            <span class="sidebar-child-session-toggle__count">
              {session().childSessionKeys.length}
            </span>
          )}
        </button>
      ) : undefined}
      <span class="sidebar-recent-session__aside session-row-aside">
        <span class="session-row-actions">
          {!session().pinnable ? undefined : (
            <button
              class="session-action session-action--pin"
              data-sidebar-session-pin="true"
              type="button"
              title={pinLabel()}
              aria-label={pinLabel()}
              onClick={() => host().toggleSessionPin(session())}
            >
              <Icon name="pin" />
            </button>
          )}
          <openclaw-tooltip
            prop:content={(() => {
              const access = archiveAccess();
              return access.allowed ? archiveLabel() : access.reason;
            })()}
            prop:describe={false}
          >
            <button
              class="session-action"
              data-sidebar-session-archive="true"
              type="button"
              aria-label={`${archiveLabel()}: ${label()}`}
              disabled={!archiveAccess().allowed || !archiveAllowed() || archiving()}
              onClick={(event: MouseEvent) => {
                event.stopPropagation();
                if (session().archived) {
                  void host().sessionOrganizer.patchSession(
                    session(),
                    {
                      archived: false,
                    },
                    {
                      sessionScope: true,
                    },
                  );
                } else {
                  void host().sessionOrganizer.archiveSessionWithUndo(session());
                }
              }}
            >
              {session().archived ? <Icon name="archiveRestore" /> : <Icon name="archive" />}
            </button>
          </openclaw-tooltip>
          <button
            class="session-action session-action--touch-menu"
            data-sidebar-session-menu="true"
            disabled={Boolean(host().sidebarSnapshot)}
            type="button"
            title={t("chat.sidebar.openSessionMenu")}
            aria-label={`${t("chat.sidebar.openSessionMenu")}: ${label()}`}
            aria-haspopup="menu"
            aria-expanded={String(menuOpen())}
            onClick={(event) => {
              event.stopPropagation();
              host().toggleSessionMenu(session(), event.currentTarget, display()?.catalogMenu);
            }}
          >
            <Icon name="moreHorizontal" />
          </button>
        </span>
      </span>
    </div>
  );
  return row;
}
export function renderChildSessionLoadError(host: SessionListHost, parentKey: string) {
  const error = createMemo(() => host.sessionData.childSessionErrorsByParent.get(parentKey));
  return (
    <Show when={error()}>
      <div
        class="sidebar-session-error callout danger"
        data-child-session-error={parentKey}
        role="alert"
      >
        <span>{error()}</span>
        <button
          class="sidebar-session-tree__show-more"
          type="button"
          data-retry-child-sessions={parentKey}
          onClick={() => host.sessionData.retryChildSessions(parentKey)}
        >
          {t("common.retry")}
        </button>
      </div>
    </Show>
  );
}
export function renderSessionTree(params: {
  host: SessionListHost;
  session: SidebarRecentSession;
  listItem?: boolean;
  icon?: JSX.Element;
}): JSX.Element {
  const host = createMemo(() => params.host),
    session = createMemo(() => params.session, {
      equals: false,
    }),
    listItem = createMemo(() => params.listItem ?? true),
    icon = createMemo(() => params.icon);
  const expanded = createMemo(() => host().isSessionChildrenExpanded(session()));
  const visibleChildren = createMemo(() =>
    visibleSessionChildren({
      session: session(),
      fullyShown: host().isSessionChildrenFullyShown(session().key),
    }),
  );
  const hiddenChildCount = createMemo(() => session().children.length - visibleChildren().length);
  return (
    <div
      class="sidebar-session-tree"
      data-session-tree={session().key}
      role={listItem() ? "listitem" : undefined}
    >
      {renderRecentSession({
        get host() {
          return host();
        },
        get session() {
          return session();
        },
        get listItem() {
          return false;
        },
        get icon() {
          return icon();
        },
      })}
      {expanded() ? (
        <div class="sidebar-session-tree__children">
          {visibleChildren().length > 0 ? (
            <div
              class="sidebar-session-tree__list"
              role={listItem() ? "list" : undefined}
              aria-label={listItem() ? t("sessionsView.childSessions") : undefined}
            >
              <For each={visibleChildren()} keyed={(child) => child.key}>
                {(child) =>
                  renderSessionTree({
                    get host() {
                      return host();
                    },
                    get session() {
                      return child();
                    },
                    get listItem() {
                      return listItem();
                    },
                  })
                }
              </For>
            </div>
          ) : undefined}
          {hiddenChildCount() > 0 ? (
            <button
              class="sidebar-session-tree__show-more"
              type="button"
              data-show-more-children={session().key}
              aria-label={t("sessionsView.showMoreChildren", {
                count: String(hiddenChildCount()),
              })}
              onClick={() => host().showMoreChildren(session().key)}
            >
              {t("sessionsView.showMoreChildren", {
                count: String(hiddenChildCount()),
              })}
            </button>
          ) : undefined}
          <For each={session().childLoadParentKeys ?? [session().key]}>
            {(key) => renderChildSessionLoadError(host(), key)}
          </For>
          {session().loadingChildren && session().children.length === 0 ? (
            <span
              class="sidebar-session-tree__loading skeleton skeleton-line skeleton-line--medium"
              role="status"
              aria-busy="true"
              aria-label={t("common.loading")}
            />
          ) : undefined}
        </div>
      ) : undefined}
    </div>
  );
}
export { renderSidebarSessionIndicators };
