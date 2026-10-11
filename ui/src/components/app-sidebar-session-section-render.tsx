import { createMemo, For, Show } from "solid-js";
import { presenceUserKey } from "../../../src/shared/presence-user.ts";
import { presenceActivityLabel, presenceViewerLabel } from "../lib/presence-users.ts";
import { t } from "../lib/reactive/i18n.ts";
import { renderHoverMarquee } from "../lib/solid/hover-marquee.tsx";
import type {
  RenderableSessionSection,
  SidebarSessionListHost,
  PersonHeaders,
} from "./app-sidebar-session-render-types.ts";
import { renderSessionTree } from "./app-sidebar-session-row-render.tsx";
import { renderSidebarSessionSectionHeader } from "./app-sidebar-session-section-header.tsx";
import {
  rowDemandsVisibility,
  RowVisibilityReason,
  SIDEBAR_SESSION_PAGE_SIZE,
  SIDEBAR_SESSION_SEE_LESS_THRESHOLD,
} from "./app-sidebar-session-types.ts";
import { Icon } from "./solid/icon.tsx";
import { renderNewSessionLink } from "./solid/new-session-link.tsx";
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
            name: personOwnerValue.label || personOwnerValue.id,
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
  const sectionClass = createMemo(() => {
    const zoneValue = zone();
    const collapsedValue = collapsed();
    const hostValue = host();
    const sectionValue = section();
    return [
      "sidebar-recent-sessions__group",
      `sidebar-recent-sessions__group--zone-${zoneValue}`,
      collapsedValue ? "sidebar-recent-sessions__group--collapsed" : "",
      hostValue.sessionOrganizer.draggingSidebarSection === sectionValue.id
        ? "sidebar-recent-sessions__group--dragging"
        : "",
      hostValue.sessionOrganizer.sessionDropTarget === sectionValue.id
        ? "sidebar-recent-sessions__group--session-drop"
        : "",
      hostValue.sessionOrganizer.sidebarSectionDropTarget?.sectionId === sectionValue.id
        ? `sidebar-recent-sessions__group--section-drop-${hostValue.sessionOrganizer.sidebarSectionDropTarget.position}`
        : "",
    ]
      .filter(Boolean)
      .join(" ");
  });
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
  return (
    <div
      class={sectionClass()}
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
      {section().renderHeader
        ? renderSidebarSessionSectionHeader({
            get sectionId() {
              return section().id;
            },
            get status() {
              return headerStatus()
                ? {
                    content: headerStatus(),
                    label: label(),
                    expanded: !collapsed(),
                    onToggle: () => host().toggleSection(section().id),
                  }
                : undefined;
            },
            get draggable() {
              return !derivedSection();
            },
            get disabledReason() {
              return (() => {
                const access = groupWriteAccess();
                return access.allowed ? undefined : access.reason;
              })();
            },
            onStartDrag: (sectionId) => host().sessionOrganizer.startSidebarSectionDrag(sectionId),
            onFinishDrag: () => host().sessionOrganizer.finishSidebarSectionDrag(),
            get reorder() {
              return {
                label: label(),
                onMove: (target: string, position: "before" | "after") =>
                  host().sessionOrganizer.reorderSidebarSection(section().id, target, position),
              };
            },
            get onContextMenu() {
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
            },
            get content() {
              return (
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
                  {group() || section().id === "ungrouped"
                    ? renderNewSessionLink({
                        get basePath() {
                          return host().basePath;
                        },
                        get agentId() {
                          return host().expandedAgentId();
                        },
                        get target() {
                          return {
                            group: group() ?? "",
                          };
                        },
                        get className() {
                          return "sidebar-session-group-actions sidebar-new-session";
                        },
                        get label() {
                          return t("sessionsView.newSessionInGroup", {
                            group: label(),
                          });
                        },
                        get disabledReason() {
                          return (() => {
                            const access = newSessionAccess();
                            return access.allowed ? undefined : access.reason;
                          })();
                        },
                        onOpen: (agentId, target) => host().requestOpenNewSession(agentId, target),
                      })
                    : undefined}
                  <Show when={group()}>
                    {(currentGroup) => (
                      <button
                        type="button"
                        class="sidebar-session-group-actions"
                        title={t("sessionsView.groupMenu", {
                          group: currentGroup(),
                        })}
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
              );
            },
          })
        : undefined}
      {collapsed() ? undefined : (
        <>
          {section().rows.length > 0 ? (
            <div class="sidebar-recent-sessions__list" role="list" aria-label={label()}>
              <For each={section().rows} keyed={(session) => session.key}>
                {(session) =>
                  renderSessionTree({
                    get host() {
                      return host();
                    },
                    get session() {
                      return session();
                    },
                  })
                }
              </For>
            </div>
          ) : undefined}
          {renderSessionPagination({
            get host() {
              return host();
            },
            get section() {
              return section();
            },
          })}
        </>
      )}
    </div>
  );
}

/** Fetching a page is useless if the new rows land behind a section's local cap,
 *  so an explicit roster load reveals a page in every section too -- otherwise
 *  the click can look like undefined happened. */

/** Section paging only reveals rows the roster already holds. Fetching the next
 *  roster page is a list-level action because it feeds every section at once --
 *  bolting it to one section left the others unable to recover missing rows. */
function renderSessionPagination(params: {
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
