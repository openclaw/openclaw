import { html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { html as staticHtml, literal } from "lit/static-html.js";
import { presenceUserKey } from "../../../src/shared/presence-user.ts";
import { t } from "../i18n/index.ts";
import { renderHoverMarquee } from "../lib/hover-marquee.ts";
import {
  presenceViewerActivity,
  presenceActivityLabel,
  presenceViewerLabel,
  projectOnlinePresenceViewers,
  type PresenceViewer,
} from "../lib/presence-users.ts";
import type { AppSidebarRenderHost } from "./app-sidebar-render.ts";
import { renderSidebarSessionSectionHeader } from "./app-sidebar-session-section-header.ts";
import { icons } from "./icons.ts";
import { personActivityLink, personActivityRouting } from "./person-activity-link.ts";

const onlineFaces = new WeakMap<AppSidebarRenderHost, readonly PresenceViewer[]>();

export function renderAppSidebarOnline(host: AppSidebarRenderHost) {
  const sectionId = "online";
  const team = host.sidebarAgentsMode === "roster";
  const collapsed = team ? !host.teamOnlineExpanded : host.collapsedSessionSections.has(sectionId);
  const label = t("presence.rosterTitle");
  let onlineUsers = projectOnlinePresenceViewers(host.sessionData.presencePayload);
  const previousFaces = onlineFaces.get(host);
  // Recheck activity ordering on each render, but retain equal facepile inputs.
  if (
    previousFaces?.length === onlineUsers.length &&
    onlineUsers.every((user, index) => user === previousFaces[index])
  ) {
    onlineUsers = previousFaces;
  } else {
    onlineFaces.set(host, onlineUsers);
  }
  if (onlineUsers.length === 0) {
    return nothing;
  }
  const counts = host.sessionData.ownerCounts.counts;
  const countsFor = (user: PresenceViewer) =>
    counts && user.identity?.type === "profile"
      ? (counts.get(user.identity.id) ?? { open: 0, running: 0 })
      : null;
  // The default keeps presence groups and running-first ordering; explicit count sorts span groups.
  const now = Date.now();
  const activityOrder = { active: 0, idle: 1, unknown: 2 };
  const running = (user: PresenceViewer) => Number((countsFor(user)?.running ?? 0) > 0);
  const filtered = host.people.statusFilter === "running";
  const listUsers = onlineUsers
    .filter((user) => !filtered || running(user) > 0)
    .toSorted((a, b) => {
      const order =
        host.people.sortMode === "presence"
          ? activityOrder[presenceViewerActivity(a, now)] -
              activityOrder[presenceViewerActivity(b, now)] || running(b) - running(a)
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
    });
  const routing = personActivityRouting(
    { basePath: host.basePath, navigate: (route, options) => host.onNavigate?.(route, options) },
    () => host.dismissTransientMenus(),
  );
  return html`
    <section class="sidebar-online" aria-label=${label} data-session-section=${sectionId}>
      ${renderSidebarSessionSectionHeader({
        sectionId,
        draggable: false,
        onStartDrag: () => undefined,
        onFinishDrag: () => undefined,
        content: html`
          <button
            type="button"
            class="sidebar-session-group-toggle"
            aria-expanded=${String(!collapsed)}
            aria-label=${label}
            @click=${() => {
              if (team) {
                host.teamOnlineExpanded = collapsed;
              } else {
                host.toggleSection(sectionId);
              }
            }}
          >
            <span class="sidebar-session-group-toggle__lead" aria-hidden="true">
              <span class="sidebar-session-group-toggle__icon"
                >${collapsed ? icons.chevronRight : icons.chevronDown}</span
              >
            </span>
            ${renderHoverMarquee(label, "sidebar-recent-sessions__label-text")}
            ${
              collapsed
                ? html`<span class="sidebar-online__facepile">
                    <openclaw-viewer-facepile
                      .staticUsers=${onlineUsers}
                      .maxVisible=${2}
                    ></openclaw-viewer-facepile>
                  </span>`
                : nothing
            }
          </button>
          <button
            type="button"
            class="sidebar-session-toolbar__button sidebar-online__filter-toggle sidebar-session-sort ${filtered ? "sidebar-session-sort--filtered" : ""}"
            aria-label=${t("presence.filters.label")}
            title=${t("presence.filters.label")}
            aria-haspopup="dialog"
            aria-expanded=${String(host.sidebarMenus.peopleFilterMenuPosition !== null)}
            @click=${(event: MouseEvent) => {
              if (event.currentTarget instanceof HTMLElement) {
                host.sidebarMenus.togglePeopleFilterMenu(event.currentTarget);
              }
            }}
          >
            ${icons.listFilter}
          </button>
        `,
      })}
      ${
        collapsed
          ? nothing
          : html`<div class="sidebar-online__list">
                ${listUsers.length === 0 ? html`<span class="sidebar-session-empty-hint">${counts === null ? t("presence.sessions.unavailable") : t("presence.filters.noMatches")}</span>` : nothing}
                ${repeat(listUsers, presenceUserKey, (user) => {
                  const activityState = presenceViewerActivity(user);
                  const workload = countsFor(user);
                  const workloadLabel = workload
                    ? t("presence.sessions.counts", {
                        open: String(workload.open),
                        running: String(workload.running),
                      })
                    : t("presence.sessions.unavailable");
                  const activity = personActivityLink(
                    user.identity?.id,
                    routing,
                    presenceViewerLabel(user),
                  );
                  const tag = activity ? literal`a` : literal`button`;
                  return staticHtml`<div
                  class="sidebar-online__row"
                  data-person-card
                  data-person-card-section="online"
                >
                  <${tag}
                    class="sidebar-online__person"
                    type=${activity ? nothing : "button"}
                    href=${activity?.href ?? nothing}
                    @click=${activity?.open ?? nothing}
                    data-online-user-id=${user.id}
                    data-presence-activity=${activityState}
                    aria-description=${`${presenceActivityLabel(activityState)} · ${workloadLabel}`}
                    title=${workload ? nothing : t("presence.sessions.unavailable")}
                    data-person-card-key=${presenceUserKey(user)}
                    data-person-card-trigger
                    aria-haspopup="dialog"
                    aria-expanded="false"
                    aria-label=${t(activity ? "presence.card.ariaLabel" : "presence.card.details", {
                      name: presenceViewerLabel(user),
                    })}
                  >
                    <span class="sidebar-online__avatar" aria-hidden="true">
                      <openclaw-viewer-avatar
                        .user=${user}
                        .markAsViewer=${false}
                        variant="footer"
                      ></openclaw-viewer-avatar>
                    </span>
                    <span class="sidebar-online__person-name">${presenceViewerLabel(user)}</span>
                    ${
                      workload && (workload.open > 0 || workload.running > 0)
                        ? html`<span class="sidebar-online__counts" aria-hidden="true">
                            ${
                              workload.running > 0
                                ? html`<span
                                    class="sidebar-online__running"
                                    data-session-count="running"
                                    title=${t("presence.sessions.runningCount", { count: String(workload.running) })}
                                    ><span class="session-run-spinner"></span
                                    ><span class="sidebar-online__count"
                                      >${workload.running}</span
                                    ></span
                                  >`
                                : nothing
                            }
                            ${
                              workload.open > 0
                                ? html`<span
                                    class="sidebar-online__open"
                                    data-session-count="open"
                                    title=${t("presence.sessions.openCount", { count: String(workload.open) })}
                                    ><span class="sidebar-online__open-icon"
                                      >${icons.messageCircle}</span
                                    ><span class="sidebar-online__count"
                                      >${workload.open}</span
                                    ></span
                                  >`
                                : nothing
                            }
                          </span>`
                        : nothing
                    }
                  </${tag}>
                </div>`;
                })}
              </div>
              ${
                host.sessionData.ownerCounts.error
                  ? html`<button
                      type="button"
                      class="sidebar-online__retry"
                      @click=${() => host.sessionData.ownerCounts.refresh()}
                    >
                      ${t("presence.sessions.retry")}
                    </button>`
                  : nothing
              }`
      }
    </section>
  `;
}
