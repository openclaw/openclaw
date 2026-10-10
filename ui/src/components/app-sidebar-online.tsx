import type { JSX } from "@solidjs/web";
import { Dynamic } from "@solidjs/web";
import { createMemo, For, Show } from "solid-js";
import { presenceUserKey } from "../../../src/shared/presence-user.ts";
import {
  presenceViewerActivity,
  presenceActivityLabel,
  presenceViewerLabel,
  projectOnlinePresenceViewers,
  type PresenceViewer,
} from "../lib/presence-users.ts";
import { t } from "../lib/reactive/i18n.ts";
import { renderHoverMarquee } from "../lib/solid/hover-marquee.tsx";
import type { AppSidebarRenderHost } from "./app-sidebar-render.tsx";
import { renderSidebarSessionSectionHeader } from "./app-sidebar-session-section-header.tsx";
import { personActivityLink, personActivityRouting } from "./person-activity-link.ts";
import { Icon } from "./solid/icon.tsx";

const onlineFaces = new WeakMap<AppSidebarRenderHost, readonly PresenceViewer[]>();

export function renderAppSidebarOnline(host: AppSidebarRenderHost): JSX.Element {
  const sectionId = "online";
  const team = createMemo(() => host.sidebarAgentsMode === "roster");
  const collapsed = createMemo(() =>
    team() ? !host.teamOnlineExpanded : host.collapsedSessionSections.has(sectionId),
  );
  const label = createMemo(() => t("presence.rosterTitle"));
  const onlineUsers = createMemo(() => {
    const users = projectOnlinePresenceViewers(host.sessionData.presencePayload);
    const previous = onlineFaces.get(host);
    // Retain equal facepile inputs while rechecking the activity ordering.
    if (
      previous?.length === users.length &&
      users.every((user, index) => user === previous[index])
    ) {
      return previous;
    }
    onlineFaces.set(host, users);
    return users;
  });
  const counts = createMemo(() => host.sessionData.ownerCounts.counts, { equals: false });
  const countsFor = (user: PresenceViewer) =>
    counts() && user.identity?.type === "profile"
      ? (counts()?.get(user.identity.id) ?? { open: 0, running: 0 })
      : null;
  // The default keeps presence groups and running-first ordering; explicit count sorts span groups.
  const now = () => Date.now();
  const activityOrder = { active: 0, idle: 1, unknown: 2 };
  const running = (user: PresenceViewer) => Number((countsFor(user)?.running ?? 0) > 0);
  const filtered = createMemo(() => host.people.statusFilter === "running");
  const listUsers = createMemo(() =>
    onlineUsers()
      .filter((user) => !filtered() || running(user) > 0)
      .toSorted((a, b) => {
        const order =
          host.people.sortMode === "presence"
            ? activityOrder[presenceViewerActivity(a, now())] -
                activityOrder[presenceViewerActivity(b, now())] || running(b) - running(a)
            : host.people.sortMode === "name"
              ? 0
              : (countsFor(b)?.[host.people.sortMode] ?? -1) -
                (countsFor(a)?.[host.people.sortMode] ?? -1);
        return (
          order ||
          presenceViewerLabel(a).localeCompare(presenceViewerLabel(b), undefined, {
            sensitivity: "base",
          })
        );
      }),
  );
  const routing = personActivityRouting(
    { basePath: host.basePath, navigate: (route, options) => host.onNavigate?.(route, options) },
    () => host.dismissTransientMenus(),
  );
  return (
    <Show when={onlineUsers().length > 0}>
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
                  aria-expanded={String(!collapsed())}
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
                    aria-expanded={String(host.sidebarMenus.peopleFilterMenuPosition !== null)}
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
                  const workload = () => countsFor(user());
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
                        <span class="sidebar-online__person-name">
                          {presenceViewerLabel(user())}
                        </span>
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
    </Show>
  );
}
