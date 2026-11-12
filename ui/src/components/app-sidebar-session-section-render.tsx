import { createMemo, createSignal, For, onSettled, Show } from "solid-js";
import { presenceUserKey } from "../../../src/shared/presence-user.ts";
import { presenceActivityLabel, presenceViewerLabel } from "../lib/presence-users.ts";
import { t } from "../lib/reactive/i18n.ts";
import { createIntersectionObserver } from "../lib/reactive/observers.ts";
import { renderHoverMarquee } from "../lib/solid/hover-marquee.tsx";
import type {
  RenderableSessionSection,
  RosterContinuation,
  SidebarSessionListHost,
  PersonHeaders,
} from "./app-sidebar-session-render-types.ts";
import { renderSessionTree as SessionTree } from "./app-sidebar-session-row-render.tsx";
import { renderSidebarSessionSectionHeader as SessionSectionHeader } from "./app-sidebar-session-section-header.tsx";
import {
  rowDemandsVisibility,
  RowVisibilityReason,
  SIDEBAR_SESSION_PAGE_SIZE,
} from "./app-sidebar-session-types.ts";
import { createSidebarSessionWindow } from "./sidebar-session-window.tsx";
import { Icon } from "./solid/icon.tsx";
import { renderNewSessionLink as NewSessionLink } from "./solid/new-session-link.tsx";
export function renderSessionSection(params: {
  host: SidebarSessionListHost;
  section: RenderableSessionSection;
  personHeaders: PersonHeaders | undefined;
  roster?: RosterContinuation;
}) {
  const host = createMemo(() => params.host),
    section = createMemo(() => params.section),
    personHeaders = createMemo(() => params.personHeaders);
  const sessionWindow = createSidebarSessionWindow(
    () => section().rows,
    host,
    () => !(section().renderHeader && host().collapsedSessionSections.has(section().id)),
  );
  const group = createMemo(() => section().category);
  const personOwner = createMemo(() => section().personOwner);
  const personIdentity = createMemo(() => personOwner()?.identity);
  const presence = createMemo(() => {
    const personIdentityValue = personIdentity();
    const personHeadersValue = personHeaders();
    return personIdentityValue?.type === "profile"
      ? personHeadersValue?.presence.get(personIdentityValue.id)
      : undefined;
  });
  const personCard = createMemo(() => {
    const owner = personOwner();
    const identity = owner?.identity;
    return owner && identity?.type === "profile" && identity.id !== personHeaders()?.selfProfileId
      ? { id: owner.id, identity }
      : undefined;
  });
  const personCardKey = createMemo(() => {
    const personCardValue = personCard();
    return personCardValue ? presenceUserKey(personCardValue) : undefined;
  });
  const presenceLabel = createMemo(() => {
    const presenceValue = presence();
    return presenceValue ? presenceActivityLabel(presenceValue) : undefined;
  });
  // The person button's explicit aria-label hides descendant text, so the live
  // state is exposed as its accessible description via this indicator id.
  const presenceId = createMemo(() => {
    const presenceValue = presence();
    const personIdentityValue = personIdentity();
    return presenceValue && personIdentityValue
      ? `sidebar-person-presence-${personIdentityValue.id}`
      : undefined;
  });
  // renderHeader records whether this list section owns collapse UI or sits
  // directly below the global toolbar.
  const collapsed = createMemo(
    () => section().renderHeader && host().collapsedSessionSections.has(section().id),
  );
  const label = createMemo(() => {
    const personOwnerValue = personOwner();
    const personIdentityValue = personIdentity();
    const sectionValue = section();
    const groupValue = group();
    return personOwnerValue
      ? personIdentityValue?.type === "profile"
        ? presenceViewerLabel({
            id: personIdentityValue.id,
            name: personOwnerValue.label?.trim() || undefined,
          })
        : personOwnerValue.label || personOwnerValue.id
      : sectionValue.id === "pinned"
        ? t("chat.sidebar.pinned")
        : sectionValue.project
          ? sectionValue.project.name
          : sectionValue.groups
            ? t("chat.sidebar.groups")
            : sectionValue.work
              ? t("chat.sidebar.coding")
              : groupValue
                ? groupValue
                : t("chat.sidebar.otherSessions");
  });
  const zone = createMemo(() => {
    const personOwnerValue = personOwner();
    const sectionValue = section();
    const groupValue = group();
    return personOwnerValue
      ? "person"
      : sectionValue.id === "pinned"
        ? "pinned"
        : sectionValue.project
          ? "project"
          : sectionValue.groups
            ? "groups"
            : sectionValue.work
              ? "coding"
              : groupValue
                ? "category"
                : "threads";
  });
  // Collapsed Coding still signals live runs so background work stays visible.
  const collapsedRunningDot = createMemo(
    () =>
      collapsed() &&
      section().work &&
      section().rows.some((row) => rowDemandsVisibility(row, RowVisibilityReason.ActiveRun)),
  );
  const collapsedAttentionDot = createMemo(
    () =>
      collapsed() &&
      section().rows.some((row) => rowDemandsVisibility(row, RowVisibilityReason.Attention)),
  );
  const newSessionAccess = createMemo(() => host().readNewSessionAccess());
  const groupWriteAccess = createMemo(() =>
    host().readSessionMutationAccess({
      method: "sessions.groups.put",
      requiredScope: "operator.write",
    }),
  );
  // Pinned holds personal pins: it accepts session drops without group write
  // access and is never reordered among the stored sections.
  const pinned = createMemo(() => section().id === "pinned");
  // Person/project/agent sections are derived, not stored: dropping a session on
  // them cannot persist anything, so they take no drags at all.
  const derivedSection = createMemo(() =>
    Boolean(pinned() || personOwner() || section().project || section().id.startsWith("agent:")),
  );
  const sectionDropEnabled = createMemo(
    () => pinned() || (groupWriteAccess().allowed && !derivedSection()),
  );
  const chevron = (
    <span class="sidebar-session-group-toggle__lead" aria-hidden="true">
      <span class="sidebar-session-group-toggle__icon">
        {collapsed() ? <Icon name="chevronRight" /> : <Icon name="chevronDown" />}
      </span>
    </span>
  );
  const ownerAvatar = createMemo(() => {
    const owner = personOwner();
    return owner ? (
      <span class="sidebar-session-group-toggle__person">
        <openclaw-viewer-avatar
          prop:identity={owner.identity}
          prop:user={{
            id: owner.id,
            name: owner.label,
            avatarUrl: owner.avatarUrl,
            watchedSessions: [],
          }}
          prop:markAsViewer={false}
          variant="session"
          aria-hidden="true"
        />
        {presence() ? (
          <span
            id={presenceId() ?? undefined}
            class={[
              "sidebar-session-group-presence",
              `sidebar-session-group-presence--${presence()}`,
            ]}
            role="img"
            aria-label={presenceLabel()}
          />
        ) : undefined}
      </span>
    ) : undefined;
  });
  const labelText = createMemo(() =>
    renderHoverMarquee(label(), "sidebar-recent-sessions__label-text"),
  );
  const headerStatus = createMemo(() =>
    collapsedRunningDot() || collapsedAttentionDot() ? (
      <>
        {collapsedRunningDot() ? (
          <span
            class="session-run-spinner sidebar-session-group-running"
            role="img"
            aria-label={t("sessionsView.activeRun")}
            title={t("sessionsView.activeRun")}
          />
        ) : undefined}
        {collapsedAttentionDot() ? (
          <span
            class="session-unread-dot sidebar-session-group-attention"
            role="img"
            aria-label={t("sessionsView.attentionRequired")}
            title={t("sessionsView.attentionRequired")}
          />
        ) : undefined}
      </>
    ) : undefined,
  );
  let personHeader: HTMLElement | undefined;
  onSettled(() => () => {
    if (host().presencePeople?.get(section().id) === personHeader) {
      host().presencePeople?.delete(section().id);
    }
  });
  return (
    <div
      class={[
        "sidebar-recent-sessions__group",
        `sidebar-recent-sessions__group--zone-${zone()}`,
        host().sessionOrganizer.sidebarSectionDropTarget?.sectionId === section().id &&
          `sidebar-recent-sessions__group--section-drop-${host().sessionOrganizer.sidebarSectionDropTarget?.position}`,
        {
          "sidebar-recent-sessions__group--headless": !section().renderHeader,
          // A headerless Person catch-all shares the selected owner's title column,
          // even when older rows lack identity metadata for a named Person section.
          "sidebar-recent-sessions__group--inline-owner":
            !section().renderHeader &&
            (section().id.startsWith("person:") ||
              (section().id === "ungrouped" && host().sessionsGrouping === "person")),
          "sidebar-recent-sessions__group--collapsed": collapsed(),
          "sidebar-recent-sessions__group--dragging":
            host().sessionOrganizer.draggingSidebarSection === section().id,
          "sidebar-recent-sessions__group--session-drop":
            host().sessionOrganizer.sessionDropTarget === section().id,
        },
      ]}
      data-session-section={section().id}
      data-zone={zone()}
      onDragOver={(event: DragEvent) => {
        if (sectionDropEnabled()) {
          host().sessionOrganizer.sectionDragOver(event, section().id, group());
        }
      }}
      onDragLeave={(event: DragEvent) => {
        if (sectionDropEnabled()) {
          host().sessionOrganizer.sectionDragLeave(event, section().id, group());
        }
      }}
      onDrop={(event: DragEvent) => {
        if (sectionDropEnabled()) {
          host().sessionOrganizer.sectionDrop(event, section().id, group());
        }
      }}
    >
      {section().renderHeader ? (
        <SessionSectionHeader
          sectionId={section().id}
          sectionHeaders={host().sessionOrganizer.sectionHeaders}
          status={
            headerStatus()
              ? {
                  content: headerStatus(),
                  label: label(),
                  expanded: !collapsed(),
                  onToggle: () => host().toggleSection(section().id),
                }
              : undefined
          }
          draggable={!derivedSection()}
          disabledReason={(() => {
            const access = groupWriteAccess();
            return access.allowed || pinned() ? undefined : access.reason;
          })()}
          onStartDrag={(sectionId) => host().sessionOrganizer.startSidebarSectionDrag(sectionId)}
          onFinishDrag={() => host().sessionOrganizer.finishSidebarSectionDrag()}
          onContextMenu={(() => {
            const currentGroup = group();
            return currentGroup
              ? (event: MouseEvent) => {
                  event.preventDefault();
                  host().sidebarMenus.openSessionGroupMenu(
                    currentGroup,
                    event.clientX,
                    event.clientY,
                    null,
                  );
                }
              : undefined;
          })()}
          content={
            <>
              {personCard() ? (
                <>
                  <button
                    type="button"
                    class="sidebar-session-group-toggle sidebar-session-group-toggle--lead"
                    aria-expanded={collapsed() ? "false" : "true"}
                    aria-label={label()}
                    onClick={() => host().toggleSection(section().id)}
                  >
                    {chevron}
                  </button>
                  <button
                    ref={(element) => {
                      personHeader = element;
                      host().presencePeople?.set(section().id, element);
                    }}
                    type="button"
                    class="sidebar-session-group-person"
                    data-person-card=""
                    data-person-card-key={personCardKey()}
                    aria-haspopup="dialog"
                    aria-expanded="false"
                    aria-label={t("presence.card.details", {
                      name: label(),
                    })}
                    aria-describedby={presenceId() ?? undefined}
                  >
                    {ownerAvatar()}
                    {labelText()}
                  </button>{" "}
                </>
              ) : (
                <button
                  type="button"
                  class="sidebar-session-group-toggle"
                  aria-expanded={collapsed() ? "false" : "true"}
                  aria-label={label()}
                  title={section().project?.path ?? undefined}
                  onClick={() => host().toggleSection(section().id)}
                >
                  {chevron}
                  {ownerAvatar()}
                  {labelText()}
                </button>
              )}
              {group() || section().id === "ungrouped" ? (
                <NewSessionLink
                  basePath={host().basePath}
                  agentId={host().expandedAgentId()}
                  target={{ group: group() ?? "" }}
                  class="sidebar-session-group-actions sidebar-new-session"
                  label={t("sessionsView.newSessionInGroup", { group: label() })}
                  disabledReason={(() => {
                    const access = newSessionAccess();
                    return access.allowed ? undefined : access.reason;
                  })()}
                  onOpen={(agentId, target) => host().requestOpenNewSession(agentId, target)}
                />
              ) : undefined}
              <Show when={group()}>
                {(currentGroup) => (
                  <button
                    type="button"
                    class="sidebar-session-group-actions"
                    title={t("sessionsView.groupOptions")}
                    aria-label={t("sessionsView.groupMenu", {
                      group: currentGroup(),
                    })}
                    aria-haspopup="menu"
                    aria-expanded={
                      host().sidebarMenus.sessionGroupMenu?.group === currentGroup()
                        ? "true"
                        : "false"
                    }
                    onClick={(event) => {
                      event.stopPropagation();
                      const trigger = event.currentTarget;
                      const rect = trigger.getBoundingClientRect();
                      host().sidebarMenus.openSessionGroupMenu(
                        currentGroup(),
                        rect.right,
                        rect.bottom + 4,
                        trigger,
                      );
                    }}
                  >
                    <Icon name="moreHorizontal" />
                  </button>
                )}
              </Show>
            </>
          }
        />
      ) : undefined}
      {collapsed() ? undefined : (
        <>
          {section().rows.length > 0 ? (
            <div class="sidebar-recent-sessions__list" role="list" aria-label={label()}>
              <div
                ref={sessionWindow.bind}
                class="sidebar-session-window"
                role="presentation"
                style={{ position: "relative", height: sessionWindow.height() }}
              >
                <For each={sessionWindow.rows()} keyed={(session) => session.key}>
                  {(session) => (
                    <SessionTree
                      host={host()}
                      session={session()}
                      pinReorder={pinned()}
                      window={sessionWindow}
                      listPosition={{
                        index: section().rows.indexOf(session()),
                        count: section().rows.length,
                      }}
                    />
                  )}
                </For>
              </div>
            </div>
          ) : undefined}
          <SessionPagination host={host()} section={section()} roster={params.roster} />
        </>
      )}
    </div>
  );
}

/** The fetch for older roster pages, wherever the list places it. */
export function RosterLoadMoreButton(props: { host: SidebarSessionListHost; loading: boolean }) {
  return (
    <button
      type="button"
      class="sidebar-session-pagination__button"
      aria-label={props.loading ? t("common.loading") : t("chat.selectors.loadMoreRosterSessions")}
      disabled={props.loading}
      aria-busy={props.loading ? "true" : "false"}
      onClick={() => void props.host.loadMoreSidebarSessions()}
    >
      {props.loading ? <span class="session-run-spinner" aria-hidden="true" /> : undefined}
      {props.loading ? t("common.loading") : t("chat.selectors.loadMoreRosterSessions")}
    </button>
  );
}

/** Section paging reveals rows the roster already holds. A roster page feeds
 *  every section at once, so grouped views fetch it below the list. The flat
 *  list is one section: it continues at its own end, loaded rows first, and a
 *  collapsed list has no end to continue from. */
function SessionPagination(params: {
  host: SidebarSessionListHost;
  section: RenderableSessionSection;
  roster: RosterContinuation | undefined;
}) {
  const host = createMemo(() => params.host),
    section = createMemo(() => params.section);
  const canShowMore = createMemo(() => section().visibleRowCount < section().totalRowCount);
  const canShowLess = createMemo(
    () => section().visibleRowCount > section().collapsedVisibleRowCount,
  );
  const canLoadMore = createMemo(() => params.roster?.hasMore === true && !canShowMore());
  const showMore = () =>
    host().setVisibleSessionLimit(section().id, section().visibleLimit + SIDEBAR_SESSION_PAGE_SIZE);
  const [end, setEnd] = createSignal<HTMLDivElement>();
  // Observation follows the element alone. Page and row updates must not
  // observe it again: every new observation reports an end still in view.
  const observedEnd = createMemo(() => (params.roster ? end() : undefined));
  // One step per entry into view: the end has to leave and come back before the
  // next step, so a failed load or rows that land off-screen never loop. The
  // buttons stay as the manual and keyboard path.
  createIntersectionObserver(
    () => {
      const target = observedEnd();
      return target ? [target] : [];
    },
    (entries) => {
      if (!params.roster?.auto || !entries.some((entry) => entry.isIntersecting)) {
        return;
      }
      if (canShowMore()) {
        showMore();
      } else if (canLoadMore()) {
        void host().loadMoreSidebarSessions();
      }
    },
  );
  return (
    <Show when={canShowMore() || canShowLess() || canLoadMore()}>
      <div
        ref={setEnd}
        class={[
          "sidebar-session-pagination",
          { "sidebar-session-pagination--roster": canLoadMore() },
        ]}
      >
        {canShowMore() ? (
          <button
            type="button"
            class="sidebar-session-pagination__button"
            aria-label={t("chat.selectors.loadMoreSessions")}
            onClick={showMore}
          >
            {t("chat.selectors.loadMoreSessions")}
          </button>
        ) : undefined}
        {canLoadMore() ? (
          <RosterLoadMoreButton host={host()} loading={params.roster?.loading === true} />
        ) : undefined}
        {canShowLess() ? (
          <button
            type="button"
            class="sidebar-session-pagination__button"
            aria-label={t("usage.details.collapse")}
            onClick={() => {
              host().clearSessionSelection();
              host().resetVisibleSessionLimit(section().id);
            }}
          >
            {t("usage.details.collapse")}
          </button>
        ) : undefined}
      </div>
    </Show>
  );
}
