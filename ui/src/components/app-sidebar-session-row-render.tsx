import type { JSX } from "@solidjs/web";
import { createEffect, createMemo, For, Show, untrack } from "solid-js";
import { normalizeSessionColorValue } from "../../../packages/gateway-protocol/src/session-agent-status.js";
import { handleContextMenuEvent } from "../lib/keyboard-shortcuts.ts";
import { t } from "../lib/reactive/i18n.ts";
import { writeSessionDragData } from "../lib/sessions/drag.ts";
import {
  canArchiveSessionRow,
  parseAgentSessionKey,
  resolveUiConfiguredMainKey,
} from "../lib/sessions/session-key.ts";
import { renderHoverMarquee } from "../lib/solid/hover-marquee.tsx";
import type { CatalogBackingSessionDisplay } from "./app-sidebar-session-catalogs.ts";
import { renderSidebarSessionIndicators } from "./app-sidebar-session-indicators.tsx";
import type { SessionListHost } from "./app-sidebar-session-render-types.ts";
import { visibleSessionChildren } from "./app-sidebar-session-types.ts";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";
import { resolveSidebarSessionRowSubtitle } from "./session-row-subtitle.ts";
import { Icon } from "./solid/icon.tsx";
import { SidebarSessionSubtitle } from "./solid/session-presentation.tsx";
import { SessionTitlePlaceholder } from "./solid/session-title-placeholder.tsx";
import "./elapsed-time.tsx";
import "./tooltip.ts";

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
  const attentionKind = createMemo(
    () => (team() ? (session().ownAttention ?? session().attention) : session().attention).kind,
  );
  const label = createMemo(() => session().label);
  const subtitleState = createMemo(
    () =>
      (host().sidebarSnapshot ? session().snapshotSubtitle : undefined) ??
      resolveSidebarSessionRowSubtitle(host(), session(), display()),
  );
  const subtitle = createMemo(() => subtitleState().subtitle),
    narration = createMemo(() => subtitleState().narration),
    toolName = createMemo(() => subtitleState().toolName);
  const indicators = renderSidebarSessionIndicators(untrack(host), session, display, icon);
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
        const catalogMenu = display()?.catalogMenu;
        if (catalogMenu) {
          host().sidebarMenus.catalogMenu.open(catalogMenu, x, y, trigger ?? undefined);
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
      ? hostValue.sidebarMenus.catalogMenuView.isOpenFor(displayValue.catalogMenu.key)
      : hostValue.sidebarMenus.sessionMenu?.session.key === sessionValue.key;
  });
  const color = createMemo(() => normalizeSessionColorValue(session().color ?? ""));
  const archived = createMemo(() => session().archived === true);
  const pinnable = createMemo(() => session().pinnable);
  const hasChildren = createMemo(() => session().childSessionKeys.length > 0);
  const groupWriteAccess = createMemo(() =>
    host().readSessionMutationAccess({
      method: "sessions.groups.put",
      requiredScope: "operator.write",
    }),
  );
  const rowDraggable = createMemo(() => groupWriteAccess().allowed);
  const marqueeLabelTemplate = () => {
    const teamValue = team();
    const labelValue = label();
    return renderHoverMarquee(
      <>
        {teamValue ? undefined : indicators.originIndicators}
        {labelValue}
      </>,
      "sidebar-recent-session__name",
    );
  };
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
        {(_identity) => <>{marqueeLabelTemplate()}</>}
      </Show>
    ) : (
      marqueeLabelTemplate()
    ),
  );
  // Always reserve the lead so every title shares the section-label text line.
  let rowElement: HTMLDivElement | undefined;
  createEffect(
    () => display()?.rowRef,
    (callback) => untrack(() => callback?.(rowElement)),
  );
  const row = (
    <div
      ref={(element) => {
        rowElement = element;
      }}
      class={[
        "sidebar-recent-session session-row-host",
        {
          "sidebar-recent-session--team": team(),
          "sidebar-recent-session--colored": Boolean(color()),
          "sidebar-recent-session--child": session().isChild,
          "sidebar-recent-session--single-line":
            team() || (!subtitle() && !session().channelPresentation),
          "sidebar-session--archived": session().archived,
          "sidebar-recent-session--active": session().visuallyActive,
          "sidebar-recent-session--selected": host().selectedSessionKeys.has(session().key),
          "session-row-host--pinned": personallyPinned(),
          "session-row-host--running": running(),
          "session-row-host--draft": session().visibility === "draft",
          "session-row-host--draft-owner":
            session().visibility === "draft" && session().draftOwnedBySelf,
          "session-row-host--draft-other":
            session().visibility === "draft" && !session().draftOwnedBySelf,
          "sidebar-recent-session--attention-danger": attentionKind() === "error",
          "sidebar-recent-session--attention-amber": !["error", "none", "question"].includes(
            attentionKind(),
          ),
          "sidebar-recent-session--dragging":
            host().sessionOrganizer.draggingSessionKey === session().key,
        },
      ]}
      style={{ "--session-color": color() ? `var(--session-color-${color()})` : undefined }}
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
          <span class="sidebar-recent-session__title-row">
            <Show when={session().titlePending} fallback={marqueeLabel()}>
              <SessionTitlePlaceholder />
            </Show>
          </span>
          <span class="sidebar-recent-session__details">
            <Show when={session().channelPresentation}>
              {(channel) => (
                <span class="sidebar-recent-session__channel">
                  <span class="sr-only">
                    {t("sessionHovercard.linkedChannel", {
                      channel: channel().channelLabel,
                    })}
                  </span>
                  <span aria-hidden="true">{channel().channelLabel}</span>
                </span>
              )}
            </Show>
            {team() ? undefined : (
              <SidebarSessionSubtitle
                subtitle={subtitle()}
                narration={narration()}
                toolName={toolName()}
              />
            )}
            {indicators.content}
          </span>
        </span>
      </a>
      <Show when={hasChildren()}>
        <button
          class={[
            "sidebar-child-session-toggle",
            {
              "sidebar-child-session-toggle--running": !team() && session().runningChildCount > 0,
              "sidebar-child-session-toggle--failed":
                !team() && !(session().runningChildCount > 0) && session().failedChildCount > 0,
            },
          ]}
          type="button"
          data-child-session-toggle={session().key}
          aria-expanded={childrenExpanded() ? "true" : "false"}
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
            <Icon name={childrenExpanded() ? "chevronDown" : "chevronRight"} />
          </span>
          {team() ? undefined : (
            <span class="sidebar-child-session-toggle__count">
              {session().childSessionKeys.length}
            </span>
          )}
        </button>
      </Show>
      <span class="sidebar-recent-session__aside session-row-aside">
        <span class="session-row-actions">
          <Show when={pinnable()}>
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
          </Show>
          <button
            class="session-action"
            data-sidebar-session-archive="true"
            type="button"
            title={(() => {
              const access = archiveAccess();
              return access.allowed ? archiveLabel() : access.reason;
            })()}
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
            <Icon name={archived() ? "archiveRestore" : "archive"} />
          </button>
          <button
            class="session-action session-action--touch-menu"
            data-sidebar-session-menu="true"
            disabled={Boolean(host().sidebarSnapshot)}
            type="button"
            title={t("chat.sidebar.openSessionMenu")}
            aria-label={`${t("chat.sidebar.openSessionMenu")}: ${label()}`}
            aria-haspopup="menu"
            aria-expanded={menuOpen() ? "true" : "false"}
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
/** The unadmitted create renders in the slot its admitted row will take: selected,
 *  actionless, and aligned with real rows. Roster groups pass their agent id. */
export function renderPendingSessionCreateRow(
  host: () => Pick<SessionListHost, "pendingSessionCreate" | "sidebarAgentsMode">,
  agentId?: string,
) {
  const pending = createMemo(() => {
    const value = host().pendingSessionCreate();
    return value &&
      (agentId === undefined ||
        parseAgentSessionKey(value.creation.sessionKey)?.agentId === agentId)
      ? value
      : undefined;
  });
  return (
    <Show when={pending()}>
      {(value) => (
        <div
          class={[
            "sidebar-recent-session session-row-host sidebar-recent-session--single-line sidebar-recent-session--active sidebar-recent-session--creating",
            { "sidebar-recent-session--team": host().sidebarAgentsMode === "roster" },
          ]}
        >
          <div class="sidebar-recent-session__link" aria-current="page" aria-busy="true">
            <span class="sidebar-session-indicator" aria-hidden="true" />
            <span class="sidebar-recent-session__text">
              <span class="sidebar-recent-session__title-row">
                <Show when={value().displayName} fallback={<SessionTitlePlaceholder />}>
                  {(name) => <span class="sidebar-recent-session__name">{name()}</span>}
                </Show>
              </span>
            </span>
          </div>
        </div>
      )}
    </Show>
  );
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
      <RecentSession host={host()} session={session()} listItem={false} icon={icon()} />
      {expanded() ? (
        <div class="sidebar-session-tree__children">
          {visibleChildren().length > 0 ? (
            <div
              class="sidebar-session-tree__list"
              role={listItem() ? "list" : undefined}
              aria-label={listItem() ? t("sessionsView.childSessions") : undefined}
            >
              <For each={visibleChildren()} keyed={(child) => child.key}>
                {(child) => <SessionTree host={host()} session={child()} listItem={listItem()} />}
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
const RecentSession = renderRecentSession;
const SessionTree = renderSessionTree;
