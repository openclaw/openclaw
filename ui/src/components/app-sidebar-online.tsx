import type { JSX } from "@solidjs/web";
import { Dynamic } from "@solidjs/web";
import { createMemo, For } from "solid-js";
import { presenceUserKey } from "../../../src/shared/presence-user.ts";
import type { ApplicationGateway } from "../app/gateway.ts";
import {
  presenceViewerActivity,
  presenceActivityLabel,
  presenceViewerLabel,
  projectOnlinePresenceViewers,
} from "../lib/presence-users.ts";
import { t } from "../lib/reactive/i18n.ts";
import { renderHoverMarquee } from "../lib/solid/hover-marquee.tsx";
import type { AppSidebarRenderHost } from "./app-sidebar-render.tsx";
import { renderSidebarSessionSectionHeader } from "./app-sidebar-session-section-header.tsx";
import { personActivityLink, personActivityRouting } from "./person-activity-link.ts";
import { sidebarOnlineCountFor, SidebarOnlineOrder } from "./sidebar-online-order.ts";
import { Icon } from "./solid/icon.tsx";

const onlineOrders = new WeakMap<
  HTMLElement,
  {
    gateway: ApplicationGateway | undefined;
    revision: number | undefined;
    viewerId: string | undefined;
    order: SidebarOnlineOrder;
  }
>();

export function sidebarOnlineOrder(host: AppSidebarRenderHost): SidebarOnlineOrder {
  const element = host.hostElement;
  const gateway = host.sessionDataContext?.gateway;
  const revision = gateway?.connectionRevision;
  const viewerId = host.sidebarSnapshot?.footer?.id ?? gateway?.snapshot.selfUser?.id;
  let cached = onlineOrders.get(element);
  if (
    !cached ||
    cached.gateway !== gateway ||
    cached.revision !== revision ||
    cached.viewerId !== viewerId
  ) {
    cached = { gateway, revision, viewerId, order: new SidebarOnlineOrder() };
    onlineOrders.set(element, cached);
  }
  return cached.order;
}

export function resolveSidebarOnline(host: AppSidebarRenderHost) {
  const saved = host.sidebarSnapshot;
  return sidebarOnlineOrder(host).resolve({
    users:
      saved?.onlineUsers ??
      (host.sessionData.presencePayload
        ? projectOnlinePresenceViewers(host.sessionData.presencePayload)
        : null),
    counts: saved ? new Map(saved.onlineCounts) : host.sessionData.ownerCounts.counts,
    countsFailed: !saved && host.sessionData.ownerCounts.error !== null,
    presentation: saved ? "snapshot" : "live",
    sortMode: host.people.sortMode,
    statusFilter: host.people.statusFilter,
  });
}

export function renderAppSidebarOnline(host: AppSidebarRenderHost): JSX.Element {
  const sectionId = "online";
  const team = createMemo(() => host.sidebarAgentsMode === "roster");
  const collapsed = createMemo(() =>
    team() ? !host.teamOnlineExpanded : host.collapsedSessionSections.has(sectionId),
  );
  const label = createMemo(() => t("presence.rosterTitle"));
  const snapshot = () => host.sidebarSnapshot;
  const online = createMemo(() => resolveSidebarOnline(host));
  const onlineUsers = () => online().users;
  const counts = () => online().counts;
  const listUsers = () => online().listUsers;
  const filtered = createMemo(() => host.people.statusFilter === "running");
  const routing = personActivityRouting(
    { basePath: host.basePath, navigate: (route, options) => host.onNavigate?.(route, options) },
    () => host.dismissTransientMenus(),
  );
  return (
    <section class="sidebar-online" aria-label={label()} data-session-section={sectionId}>
      {renderSidebarSessionSectionHeader({
        get sectionId() {
          return sectionId;
        },
        draggable: false,
        onStartDrag: () => undefined,
        onFinishDrag: () => undefined,
        get content() {
          return (
            <>
              <button
                type="button"
                class="sidebar-session-group-toggle"
                aria-expanded={!collapsed() ? "true" : "false"}
                aria-label={label()}
                onClick={() => {
                  if (team()) {
                    host.teamOnlineExpanded = collapsed();
                  } else {
                    host.toggleSection(sectionId);
                  }
                }}
              >
                <span class="sidebar-session-group-toggle__lead" aria-hidden="true">
                  <span class="sidebar-session-group-toggle__icon">
                    {collapsed() ? <Icon name="chevronRight" /> : <Icon name="chevronDown" />}
                  </span>
                </span>
                {renderHoverMarquee(label(), "sidebar-recent-sessions__label-text")}
                {collapsed() ? (
                  <span class="sidebar-online__facepile">
                    <openclaw-viewer-facepile
                      prop:staticUsers={onlineUsers()}
                      prop:maxVisible={2}
                    />
                  </span>
                ) : undefined}
              </button>
              {collapsed() ? undefined : (
                <button
                  type="button"
                  class={[
                    "sidebar-session-toolbar__button sidebar-online__filter-toggle sidebar-session-sort",
                    { "sidebar-session-sort--filtered": filtered() },
                  ]}
                  aria-label={t("presence.filters.label")}
                  title={t("presence.filters.label")}
                  aria-haspopup="dialog"
                  aria-expanded={
                    host.sidebarMenus.peopleFilterMenuPosition !== null ? "true" : "false"
                  }
                  onClick={(event: MouseEvent) => {
                    if (event.currentTarget instanceof HTMLElement) {
                      host.sidebarMenus.togglePositionedMenu("peopleFilter", event.currentTarget);
                    }
                  }}
                >
                  <Icon name="listFilter" />
                </button>
              )}
            </>
          );
        },
      })}
      {collapsed() ? undefined : (
        <>
          <div class="sidebar-online__list">
            {listUsers().length === 0 ? (
              <span class="sidebar-session-empty-hint">
                {counts() === null
                  ? t("presence.sessions.unavailable")
                  : t("presence.filters.noMatches")}
              </span>
            ) : undefined}
            <For each={listUsers()} keyed={presenceUserKey}>
              {(readUser) => {
                const user = readUser;
                const activityState = () => presenceViewerActivity(user());
                const workload = () => sidebarOnlineCountFor(counts(), user());
                const workloadLabel = () =>
                  workload()
                    ? t("presence.sessions.counts", {
                        open: String(workload()!.open),
                        running: String(workload()!.running),
                      })
                    : t("presence.sessions.unavailable");
                const activity = () =>
                  personActivityLink(user().identity?.id, routing, presenceViewerLabel(user()));

                return (
                  <div
                    class="sidebar-online__row"
                    draggable={
                      !snapshot() && user().identity?.type === "profile" ? "true" : "false"
                    }
                    onDragStart={(event: DragEvent) => {
                      const identity = user().identity;
                      if (identity?.type === "profile") {
                        host.sessionOrganizer.startSidebarEntryDrag(event, {
                          type: "person",
                          profileId: identity.id,
                        });
                      }
                    }}
                    onDragEnd={() => host.sessionOrganizer.finishSidebarEntryDrag()}
                    data-person-card
                    data-person-card-section="online"
                  >
                    <Dynamic
                      component={activity() ? "a" : "button"}
                      class="sidebar-online__person"
                      type={activity() ? undefined : "button"}
                      href={activity()?.href ?? undefined}
                      onClick={activity()?.open ?? undefined}
                      data-online-user-id={user().id}
                      data-presence-activity={activityState()}
                      aria-description={`${presenceActivityLabel(activityState())} · ${workloadLabel()}`}
                      title={workload() ? undefined : t("presence.sessions.unavailable")}
                      data-person-card-key={presenceUserKey(user())}
                      data-person-card-trigger
                      aria-haspopup="dialog"
                      aria-expanded="false"
                      aria-label={t(
                        activity() ? "presence.card.ariaLabel" : "presence.card.details",
                        {
                          name: presenceViewerLabel(user()),
                        },
                      )}
                    >
                      <span class="sidebar-online__avatar" aria-hidden="true">
                        <openclaw-viewer-avatar
                          prop:user={user()}
                          prop:markAsViewer={false}
                          variant="footer"
                        />
                      </span>
                      <span class="sidebar-online__person-name">{presenceViewerLabel(user())}</span>
                      {workload() && (workload()!.open > 0 || workload()!.running > 0) ? (
                        <span class="sidebar-online__counts" aria-hidden="true">
                          <For each={["running", "open"] as const}>
                            {(kind) =>
                              workload()![kind] > 0 ? (
                                <>
                                  <span
                                    class={`sidebar-online__${kind}`}
                                    data-session-count={kind}
                                    title={t(`presence.sessions.${kind}Count`, {
                                      count: String(workload()![kind]),
                                    })}
                                  >
                                    <span
                                      class={
                                        kind === "running"
                                          ? "session-run-spinner"
                                          : "sidebar-online__open-icon"
                                      }
                                    >
                                      {kind === "running" ? undefined : (
                                        <Icon name="messageCircle" />
                                      )}
                                    </span>
                                    <span class="sidebar-online__count">{workload()![kind]}</span>
                                  </span>
                                </>
                              ) : undefined
                            }
                          </For>
                        </span>
                      ) : undefined}
                    </Dynamic>
                    {user().identity?.type === "profile" && (
                      <button
                        type="button"
                        class="sidebar-pages__pin"
                        disabled={Boolean(snapshot())}
                        aria-label={t("nav.pin")}
                        onClick={() => {
                          const identity = user().identity;
                          if (identity?.type === "profile") {
                            host.sessionOrganizer.writeSidebarEntryAt(
                              `person:${identity.id}`,
                              undefined,
                              undefined,
                            );
                          }
                        }}
                      >
                        <Icon name="pin" />
                      </button>
                    )}
                  </div>
                );
              }}
            </For>
          </div>
          {host.sessionData.ownerCounts.error ? (
            <button
              type="button"
              class="sidebar-online__retry"
              onClick={() => void host.sessionData.ownerCounts.refresh()}
            >
              {t("presence.sessions.retry")}
            </button>
          ) : undefined}
        </>
      )}
    </section>
  );
}
