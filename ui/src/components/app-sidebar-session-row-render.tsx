import type { JSX } from "@solidjs/web";
import { createMemo, createProjection, For, onSettled, Show } from "solid-js";
import { normalizeSessionColorValue } from "../../../packages/gateway-protocol/src/session-agent-status.js";
import { handleContextMenuEvent } from "../lib/keyboard-shortcuts.ts";
import { t } from "../lib/reactive/i18n.ts";
import { writeSessionDragData } from "../lib/sessions/drag.ts";
import { canArchiveSessionRow, resolveUiConfiguredMainKey } from "../lib/sessions/session-key.ts";
import { renderHoverMarquee } from "../lib/solid/hover-marquee.tsx";
import type {
  CatalogBackingSessionDisplay,
  CatalogRowControls,
} from "./app-sidebar-session-catalogs.ts";
import { renderSidebarSessionIndicators } from "./app-sidebar-session-indicators.tsx";
import type { SessionListHost } from "./app-sidebar-session-render-types.ts";
import { visibleSessionChildren } from "./app-sidebar-session-types.ts";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";
import {
  resolveSidebarSessionSubtitle,
  sidebarSessionRowSubtitleParams,
} from "./session-row-subtitle.ts";
import { sameSidebarPresentation } from "./sidebar-projection-cache.ts";
import type { createSidebarSessionWindow } from "./sidebar-session-window.tsx";
import { Icon } from "./solid/icon.tsx";
import { SidebarSessionSubtitle } from "./solid/session-presentation.tsx";
import "./tooltip.ts";

/** Compose independently owned session state and context indicators. */

type RecentSessionParams = {
  host: SessionListHost;
  session: SidebarRecentSession;
  display?: CatalogBackingSessionDisplay;
  pinReorder?: boolean;
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
  // Reconcile presentation fields without replacing the snapshot captured by actions.
  const view = createProjection(() => params.session);
  const session = () => view;
  const actionSession = () => params.session;
  const host = createMemo(() => params.host),
    display = createMemo(() => params.display),
    listItem = createMemo(() => params.listItem ?? true),
    icon = createMemo(() => params.icon);
  const personallyPinned = createMemo(() =>
    host().sessionOrganizer.isPersonalSessionPin(session().key),
  );
  const pinDrop = createMemo(() => {
    const target = host().sessionOrganizer.sidebarZoneDropTarget;
    return params.pinReorder && target?.entry === `session:${session().key}`
      ? target.position
      : undefined;
  });
  const archiveTarget = createMemo(
    () => ({
      key: session().key,
      archived: session().archived,
      sharingRole: session().sharingRole,
    }),
    { equals: sameSidebarPresentation },
  );
  const archiveAccess = createMemo(() =>
    host().readSessionMutationAccess({
      method: "sessions.patch",
      params: {
        key: archiveTarget().key,
        archived: !archiveTarget().archived,
      },
      sessionScope: true,
      session: archiveTarget(),
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
  const subtitleInput = createMemo(
    () => {
      const snapshot = session().snapshot ? session().snapshotSubtitle : undefined;
      const input = snapshot ? null : sidebarSessionRowSubtitleParams(host(), session(), display());
      return {
        input,
        value: snapshot ?? (input ? host().sessionProjection.heldSubtitle(input) : undefined),
      };
    },
    { equals: sameSidebarPresentation },
  );
  const subtitleState = createMemo(() => {
    const { input, value } = subtitleInput();
    return (
      value ??
      (input ? resolveSidebarSessionSubtitle(input) : { subtitle: undefined, narration: undefined })
    );
  });
  const subtitle = createMemo(() => subtitleState().subtitle),
    narration = createMemo(() => subtitleState().narration),
    toolName = createMemo(() => subtitleState().toolName);
  const indicators = renderSidebarSessionIndicators(host, session, display, icon);
  const { running, stateId, metaId, pullRequest, childrenExpanded } = indicators;
  const controls: CatalogRowControls = {};
  const openMenuFromEvent: JSX.EventHandler<HTMLDivElement, MouseEvent | KeyboardEvent> = (event) =>
    handleContextMenuEvent(event, controls.link ?? null, (trigger, x, y) => {
      const catalogMenu = display()?.catalogMenu;
      if (catalogMenu) {
        host().sidebarMenus.catalogMenu.open(catalogMenu, x, y, trigger ?? undefined);
        return;
      }
      if (!host().sidebarSnapshot) {
        host().sidebarMenus.openSessionMenu(actionSession(), x, y, trigger);
      }
    });
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
  const childCount = createMemo(
    () => session().snapshot?.childCount ?? session().childSessionKeys.length,
  );
  const groupWriteAccess = createMemo(() =>
    host().readSessionMutationAccess({
      method: "sessions.groups.put",
      requiredScope: "operator.write",
    }),
  );
  // Personal pins and rail shortcuts do not mutate shared session groups.
  const rowDraggable = createMemo(() => pinnable() || groupWriteAccess().allowed);
  const marqueeLabelTemplate = () => {
    const labelValue = label();
    return renderHoverMarquee(
      <>
        {indicators.originIndicators}
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
  let rowElement: HTMLDivElement;
  let previousFocus: Element | null;
  onSettled(() => display()?.rowRef?.(rowElement, controls, previousFocus));
  const row = (
    <div
      ref={(element) => {
        rowElement = element;
        previousFocus = document.activeElement;
      }}
      class={[
        "sidebar-recent-session session-row-host",
        pinDrop() ? `sidebar-zone-entry--drop-${pinDrop()}` : undefined,
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
          "sidebar-recent-session--naming": session().titlePending,
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
          host().sessionOrganizer.startSessionDrag(actionSession());
        }
      }}
      onDragEnd={() => host().sessionOrganizer.finishSessionDrag()}
      onDragOver={(event: DragEvent) => {
        if (params.pinReorder) {
          host().sessionOrganizer.sectionDragOver(event, "pinned", undefined, session().key);
        }
      }}
      onDragLeave={(event: DragEvent) => {
        if (params.pinReorder) {
          host().sessionOrganizer.handleSidebarZoneDragLeave(event);
        }
      }}
      onDrop={(event: DragEvent) => {
        if (params.pinReorder) {
          host().sessionOrganizer.sectionDrop(event, "pinned", undefined, session().key);
        }
      }}
      onContextMenu={openMenuFromEvent}
      onKeyDown={openMenuFromEvent}
    >
      <a
        ref={(element) => (controls.link = element)}
        href={host().sidebarSessionHref(session())}
        class="sidebar-recent-session__link"
        draggable="false"
        aria-current={session().visuallyActive ? "page" : undefined}
        aria-describedby={[stateId(), metaId()].filter(Boolean).join(" ") || undefined}
        aria-busy={session().titlePending ? "true" : undefined}
        onClick={(event: MouseEvent) => host().handleSessionRowClick(event, actionSession())}
      >
        {indicators.persistentIndicator}
        <span class="sidebar-recent-session__text">
          <span class="sidebar-recent-session__title-row">{marqueeLabel()}</span>
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
      <Show when={childCount() > 0}>
        <button
          class={[
            "sidebar-child-session-toggle",
            {
              "sidebar-child-session-toggle--running": session().runningChildCount > 0,
            },
          ]}
          type="button"
          ref={(element) => (controls.children = element)}
          disabled={Boolean(session().snapshot)}
          data-child-session-toggle={session().key}
          aria-expanded={childrenExpanded() ? "true" : "false"}
          aria-label={t(
            childrenExpanded()
              ? "sessionsView.hideChildSessions"
              : "sessionsView.showChildSessions",
            {
              count: String(childCount()),
              session: label(),
            },
          )}
          aria-description={
            !childrenExpanded() && session().runningChildCount > 0
              ? t("sessionsView.activeRun")
              : undefined
          }
          onClick={() => host().toggleSessionChildren(actionSession())}
        >
          <span class="sidebar-child-session-toggle__icon" aria-hidden="true">
            <Show
              when={!childrenExpanded() && session().runningChildCount > 0}
              fallback={<Icon name={childrenExpanded() ? "chevronDown" : "chevronRight"} />}
            >
              <span class="session-run-spinner" />
            </Show>
          </span>
          <span class="sidebar-child-session-toggle__count">{childCount()}</span>
        </button>
      </Show>
      <span class="sidebar-recent-session__aside session-row-aside">
        <span class="session-row-actions">
          {/* Cached pin geometry is display-only; actions still require the live row. */}
          <Show when={session().snapshot ? session().snapshot?.pinnable !== false : pinnable()}>
            <button
              class="session-action session-action--pin"
              ref={(element) => (controls.pin = element)}
              data-sidebar-session-pin="true"
              type="button"
              title={pinLabel()}
              aria-label={pinLabel()}
              disabled={!pinnable()}
              onClick={() => host().toggleSessionPin(actionSession())}
            >
              <Icon name="pin" />
            </button>
          </Show>
          <button
            class="session-action"
            ref={(element) => (controls.archive = element)}
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
              const target = actionSession();
              if (target.archived) {
                void host().sessionOrganizer.patchSession(
                  target,
                  {
                    archived: false,
                  },
                  {
                    sessionScope: true,
                  },
                );
              } else {
                void host().sessionOrganizer.archiveSessionWithUndo(target);
              }
            }}
          >
            <Icon name={archived() ? "archiveRestore" : "archive"} />
          </button>
          <button
            class="session-action session-action--touch-menu"
            ref={(element) => (controls.menu = element)}
            data-sidebar-session-menu="true"
            disabled={Boolean(host().sidebarSnapshot)}
            type="button"
            title={t("chat.sidebar.openSessionMenu")}
            aria-label={`${t("chat.sidebar.openSessionMenu")}: ${label()}`}
            aria-haspopup="menu"
            aria-expanded={menuOpen() ? "true" : "false"}
            onClick={(event) => {
              event.stopPropagation();
              host().toggleSessionMenu(
                actionSession(),
                event.currentTarget,
                display()?.catalogMenu,
              );
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
export function renderChildSessionLoadError(host: () => SessionListHost, parentKey: string) {
  const error = createMemo(() => host().sessionData.childSessionErrorsByParent.get(parentKey));
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
          onClick={() => host().sessionData.retryChildSessions(parentKey)}
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
  pinReorder?: boolean;
  listItem?: boolean;
  icon?: JSX.Element;
  listPosition?: { index: number; count: number };
  window?: Pick<ReturnType<typeof createSidebarSessionWindow>, "rowRef" | "item" | "focus">;
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
  const windowItem = () => params.window?.item(session().key);
  return (
    <div
      ref={params.window?.rowRef(() => session().key)}
      class="sidebar-session-tree"
      data-session-tree={session().key}
      data-session-window-key={params.window ? session().key : undefined}
      style={
        windowItem()
          ? {
              position: "absolute",
              "inset-inline": "0",
              top: "0",
              transform: `translateY(${windowItem()?.top ?? 0}px)`,
            }
          : undefined
      }
      onFocusIn={() => params.window?.focus(session().key)}
      role={listItem() ? "listitem" : undefined}
      aria-posinset={params.listPosition ? params.listPosition.index + 1 : undefined}
      aria-setsize={params.listPosition?.count}
    >
      <RecentSession
        host={host()}
        session={session()}
        pinReorder={params.pinReorder}
        listItem={false}
        icon={icon()}
      />
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
            {(key) => renderChildSessionLoadError(host, key)}
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
