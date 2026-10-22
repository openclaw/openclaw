import { createMemo, For, onSettled, Show } from "solid-js";
import { presenceUserKey } from "../../../src/shared/presence-user.ts";
import { presenceActivityLabel, presenceViewerLabel } from "../lib/presence-users.ts";
import { t } from "../lib/reactive/i18n.ts";
import { renderHoverMarquee } from "../lib/solid/hover-marquee.tsx";
import type {
  RenderableSessionSection,
  SidebarSessionListHost,
  PersonHeaders,
} from "./app-sidebar-session-render-types.ts";
import {
  renderPendingSessionCreateRow,
  renderSessionTree as SessionTree,
} from "./app-sidebar-session-row-render.tsx";
import { renderSidebarSessionSectionHeader as SessionSectionHeader } from "./app-sidebar-session-section-header.tsx";
import {
  rowDemandsVisibility,
  RowVisibilityReason,
  SIDEBAR_SESSION_PAGE_SIZE,
  SIDEBAR_SESSION_SEE_LESS_THRESHOLD,
} from "./app-sidebar-session-types.ts";
import { Icon } from "./solid/icon.tsx";
import { renderNewSessionLink as NewSessionLink } from "./solid/new-session-link.tsx";
export function renderSessionSection(params: {
  host: SidebarSessionListHost;
  section: RenderableSessionSection;
  personHeaders: PersonHeaders | undefined;
}) {
  const host = createMemo(() => params.host),
    section = createMemo(() => params.section),
    personHeaders = createMemo(() => params.personHeaders);
  const totalRowCount = createMemo(() => section().totalRowCount);
  const group = createMemo(() => section().category);
  // Created rows lead their section, so a create for this group takes that slot now.
  const pendingCreate = createMemo(() => {
    const pending = host().pendingSessionCreate();
    return pending?.category && pending.category === group() ? pending : undefined;
  });
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
  // Pinned rows render in the nav zone; renderHeader records whether this list
  // section owns collapse UI or sits directly below the global toolbar.
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
  // Person/project/agent sections are derived, not stored: dropping a session on
  // them cannot persist anything, so they take no drags at all.
  const derivedSection = createMemo(() =>
    Boolean(personOwner() || section().project || section().id.startsWith("agent:")),
  );
  const sectionDropEnabled = createMemo(() => groupWriteAccess().allowed && !derivedSection());
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
  const showCount = createMemo(() => collapsed() && totalRowCount() > 0);
  const headerStatus = createMemo(() =>
    showCount() || collapsedRunningDot() || collapsedAttentionDot() ? (
      <>
        {showCount() ? (
          <span class="sidebar-session-group-count">{totalRowCount()}</span>
        ) : undefined}
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
            class="sidebar-session-group-attention"
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
          // Only a single selected owner's Person section renders without a header.
          "sidebar-recent-sessions__group--inline-owner":
            !section().renderHeader && section().id.startsWith("person:"),
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
            return access.allowed ? undefined : access.reason;
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
          {section().rows.length > 0 || pendingCreate() ? (
            <div class="sidebar-recent-sessions__list" role="list" aria-label={label()}>
              {renderPendingSessionCreateRow(pendingCreate, true)}
              <For each={section().rows} keyed={(session) => session.key}>
                {(session) => <SessionTree host={host()} session={session()} />}
              </For>
            </div>
          ) : undefined}
          <SessionPagination host={host()} section={section()} />
        </>
      )}
    </div>
  );
}

/** Section paging only reveals rows the roster already holds. Fetching the next
 *  roster page is a list-level action because it feeds every section at once --
 *  bolting it to one section left the others unable to recover missing rows. */
function SessionPagination(params: {
  host: SidebarSessionListHost;
  section: RenderableSessionSection;
}) {
  const host = createMemo(() => params.host),
    section = createMemo(() => params.section);
  const canShowMore = createMemo(() => section().visibleRowCount < section().totalRowCount);
  const canShowLess = createMemo(
    () =>
      section().visibleRowCount > SIDEBAR_SESSION_SEE_LESS_THRESHOLD &&
      section().visibleRowCount > section().collapsedVisibleRowCount,
  );
  return (
    <Show when={canShowMore() || canShowLess()}>
      <div class="sidebar-session-pagination">
        {canShowMore() ? (
          <button
            type="button"
            class="sidebar-session-pagination__button"
            aria-label={t("chat.selectors.loadMoreSessions")}
            onClick={() => {
              host().setVisibleSessionLimit(
                section().id,
                section().visibleLimit + SIDEBAR_SESSION_PAGE_SIZE,
              );
            }}
          >
            {t("chat.selectors.loadMoreSessions")}
          </button>
        ) : undefined}
        {canShowLess() ? (
          <button
            type="button"
            class="sidebar-session-pagination__button"
            aria-label={t("usage.details.collapse")}
            onClick={() => {
              host().clearSessionSelection();
              host().setVisibleSessionLimit(section().id, SIDEBAR_SESSION_PAGE_SIZE);
            }}
          >
            {t("usage.details.collapse")}
          </button>
        ) : undefined}
      </div>
    </Show>
  );
}
