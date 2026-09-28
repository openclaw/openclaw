import { html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { html as staticHtml, literal } from "lit/static-html.js";
import { presenceUserKey } from "../../../src/shared/presence-user.ts";
import { readPresenceEntries, resolveCurrentSelfUser } from "../app/user-profile.ts";
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

export function renderAppSidebarOnline(host: AppSidebarRenderHost) {
  const sectionId = "online";
  const team = host.sidebarAgentsMode === "roster";
  const collapsed = team ? !host.teamOnlineExpanded : host.collapsedSessionSections.has(sectionId);
  const label = t("presence.rosterTitle");
  const selfUser = resolveCurrentSelfUser({
    snapshotUser: host.sessionDataContext?.gateway.snapshot.selfUser,
    presenceEntries: readPresenceEntries(host.sessionData.presencePayload),
    presenceInstanceId: host.sessionData.presenceInstanceId,
  });
  const onlineUsers = projectOnlinePresenceViewers(
    host.sessionData.presencePayload,
    selfUser,
    host.sessionData.presenceInstanceId,
  );
  if (onlineUsers.length === 0) {
    return nothing;
  }
  const counts = host.sessionData.ownerCounts.counts;
  const countsFor = (user: PresenceViewer) =>
    counts && user.identity?.type === "profile"
      ? (counts.get(user.identity.id) ?? { open: 0, running: 0 })
      : null;
  const users = onlineUsers.filter(
    (user) => !host.onlineRunningOnly || !counts || (countsFor(user)?.running ?? 0) > 0,
  );
  const sort = host.onlineSessionSort;
  if (sort !== "presence") {
    users.sort((a, b) => (countsFor(b)?.[sort] ?? -1) - (countsFor(a)?.[sort] ?? -1));
  }
  const totals = users.reduce(
    (total, user) => {
      const value = countsFor(user);
      return {
        open: total.open + (value?.open ?? 0),
        running: total.running + (value?.running ?? 0),
        complete: total.complete && value !== null,
      };
    },
    { open: 0, running: 0, complete: counts !== null },
  );
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
        `,
      })}
      ${
        collapsed
          ? nothing
          : html`<div class="sidebar-online__columns">
                <button
                  type="button"
                  class="sidebar-online__filter"
                  aria-pressed=${String(host.onlineRunningOnly)}
                  aria-label=${t("presence.sessions.runningOnly")}
                  ?disabled=${counts === null}
                  @click=${() => {
                    host.onlineRunningOnly = !host.onlineRunningOnly;
                  }}
                >
                  ${t(host.onlineRunningOnly ? "presence.sessions.running" : "presence.sessions.all")}
                </button>
                ${(["open", "running"] as const).map(
                  (key) => html`<button
                    type="button"
                    class="sidebar-online__column"
                    aria-label=${t(key === "open" ? "presence.sessions.sortOpen" : "presence.sessions.sortRunning")}
                    aria-pressed=${String(sort === key)}
                    title=${t(key === "open" ? "presence.sessions.openHint" : "presence.sessions.runningHint")}
                    @click=${() => {
                      host.onlineSessionSort = sort === key ? "presence" : key;
                    }}
                  >
                    ${t(key === "open" ? "presence.sessions.open" : "presence.sessions.running")}${sort === key ? html`<span aria-hidden="true"> ↓</span>` : nothing}
                  </button>`,
                )}
              </div>
              <div
                class="sidebar-online__list ${onlineUsers.length > 50 ? "sidebar-online__list--large" : ""}"
              >
                ${repeat(users, presenceUserKey, (user) => {
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
                    class="sidebar-online__person ${
                      activityState === "idle" ? "sidebar-online__person--away" : ""
                    }"
                    type=${activity ? nothing : "button"}
                    href=${activity?.href ?? nothing}
                    @click=${activity?.open ?? nothing}
                    data-online-user-id=${user.id}
                    data-presence-activity=${activityState}
                    aria-description=${`${presenceActivityLabel(activityState)} · ${workloadLabel}`}
                    data-person-card-key=${presenceUserKey(user)}
                    data-person-card-trigger
                    aria-haspopup="dialog"
                    aria-expanded="false"
                    aria-label=${t(activity ? "presence.card.ariaLabel" : "presence.card.details", {
                      name: presenceViewerLabel(user),
                    })}
                  >
                    <openclaw-viewer-avatar
                      .user=${user}
                      .markAsViewer=${false}
                      variant="footer"
                      aria-hidden="true"
                    ></openclaw-viewer-avatar>
                    <span class="sidebar-online__person-copy">
                      <span class="sidebar-online__person-name">${presenceViewerLabel(user)}</span>
                      <span class="sidebar-online__person-status" aria-hidden="true">${t(activityState === "active" ? "presence.active" : activityState === "idle" ? "presence.idle" : "presence.rosterTitle")}</span>
                    </span>
                    <span class="sidebar-online__count" data-session-count="open" aria-hidden="true">${workload?.open ?? "—"}</span>
                    <span class="sidebar-online__count ${workload?.running ? "sidebar-online__count--running" : "sidebar-online__count--zero"}" data-session-count="running" aria-hidden="true">${workload?.running ?? "—"}</span>
                  </${tag}>
                </div>`;
                })}
                ${users.length === 0 ? html`<p class="sidebar-online__empty">${t("presence.sessions.noneRunning")}</p>` : nothing}
              </div>
              <div class="sidebar-online__totals" title=${t("presence.sessions.scope")}>
                <span>${t("presence.sessions.total")}</span>
                <span data-session-total="open">${totals.complete ? totals.open : "—"}</span>
                <span data-session-total="running">${totals.complete ? totals.running : "—"}</span>
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
