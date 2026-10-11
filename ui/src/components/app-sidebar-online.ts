import { html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { html as staticHtml, literal } from "lit/static-html.js";
import { presenceUserKey } from "../../../src/shared/presence-user.ts";
import type { ApplicationGateway } from "../app/gateway.ts";
import { t } from "../i18n/index.ts";
import { renderHoverMarquee } from "../lib/hover-marquee.ts";
import {
  presenceViewerActivity,
  presenceActivityLabel,
  presenceViewerLabel,
  projectOnlinePresenceViewers,
} from "../lib/presence-users.ts";
import type { AppSidebarRenderHost } from "./app-sidebar-render.ts";
import { renderSidebarSessionSectionHeader } from "./app-sidebar-session-section-header.ts";
import { icons } from "./icons.ts";
import { personActivityLink, personActivityRouting } from "./person-activity-link.ts";
import { sidebarOnlineCountFor, SidebarOnlineOrder } from "./sidebar-online-order.ts";

const onlineOrders = new WeakMap<
  AppSidebarRenderHost,
  {
    gateway: ApplicationGateway | undefined;
    revision: number | undefined;
    viewerId: string | undefined;
    order: SidebarOnlineOrder;
  }
>();

export function sidebarOnlineOrder(host: AppSidebarRenderHost): SidebarOnlineOrder {
  const gateway = host.sessionDataContext?.gateway;
  const revision = gateway?.connectionRevision;
  const viewerId = host.sidebarSnapshot?.footer?.id ?? gateway?.snapshot.selfUser?.id;
  let cached = onlineOrders.get(host);
  if (
    !cached ||
    cached.gateway !== gateway ||
    cached.revision !== revision ||
    cached.viewerId !== viewerId
  ) {
    cached = { gateway, revision, viewerId, order: new SidebarOnlineOrder() };
    onlineOrders.set(host, cached);
  }
  return cached.order;
}

export function renderAppSidebarOnline(host: AppSidebarRenderHost) {
  const sectionId = "online";
  const team = host.sidebarAgentsMode === "roster";
  const collapsed = team ? !host.teamOnlineExpanded : host.collapsedSessionSections.has(sectionId);
  const label = t("presence.rosterTitle");
  const snapshot = host.sidebarSnapshot;
  const {
    users: onlineUsers,
    listUsers,
    counts,
  } = sidebarOnlineOrder(host).resolve({
    users:
      snapshot?.onlineUsers ??
      (host.sessionData.presencePayload
        ? projectOnlinePresenceViewers(host.sessionData.presencePayload)
        : null),
    counts: snapshot ? new Map(snapshot.onlineCounts) : host.sessionData.ownerCounts.counts,
    countsFailed: !snapshot && host.sessionData.ownerCounts.error !== null,
    presentation: snapshot ? "snapshot" : "live",
    sortMode: host.people.sortMode,
    statusFilter: host.people.statusFilter,
  });
  const filtered = host.people.statusFilter === "running";
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
          ${
            collapsed
              ? nothing
              : html`<button
                  type="button"
                  class="sidebar-session-toolbar__button sidebar-online__filter-toggle sidebar-session-sort ${filtered ? "sidebar-session-sort--filtered" : ""}"
                  aria-label=${t("presence.filters.label")}
                  title=${t("presence.filters.label")}
                  aria-haspopup="dialog"
                  aria-expanded=${String(host.sidebarMenus.peopleFilterMenuPosition !== null)}
                  @click=${(event: MouseEvent) => {
                    if (event.currentTarget instanceof HTMLElement) {
                      host.sidebarMenus.togglePositionedMenu("peopleFilter", event.currentTarget);
                    }
                  }}
                >
                  ${icons.listFilter}
                </button>`
          }
        `,
      })}
      ${
        collapsed
          ? nothing
          : html`<div class="sidebar-online__list">
                ${listUsers.length === 0 ? html`<span class="sidebar-session-empty-hint">${counts === null ? t("presence.sessions.unavailable") : t("presence.filters.noMatches")}</span>` : nothing}
                ${repeat(listUsers, presenceUserKey, (user) => {
                  const activityState = presenceViewerActivity(user);
                  const workload = sidebarOnlineCountFor(counts, user);
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
                  draggable=${!snapshot && user.identity?.type === "profile" ? "true" : "false"}
                  @dragstart=${(event: DragEvent) => {
                    if (user.identity?.type === "profile") {
                      host.sessionOrganizer.startSidebarEntryDrag(event, {
                        type: "person",
                        profileId: user.identity.id,
                      });
                    }
                  }}
                  @dragend=${() => host.sessionOrganizer.finishSidebarEntryDrag()}
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
                            ${(["running", "open"] as const).map((kind) =>
                              workload[kind] > 0
                                ? html`<span
                                    class=${`sidebar-online__${kind}`}
                                    data-session-count=${kind}
                                    title=${t(`presence.sessions.${kind}Count`, { count: String(workload[kind]) })}
                                    ><span
                                      class=${kind === "running" ? "session-run-spinner" : "sidebar-online__open-icon"}
                                      >${kind === "running" ? nothing : icons.messageCircle}</span
                                    ><span class="sidebar-online__count"
                                      >${workload[kind]}</span
                                    ></span
                                  >`
                                : nothing,
                            )}
                          </span>`
                        : nothing
                    }
                  </${tag}>
                  ${
                    user.identity?.type === "profile"
                      ? html`<button
                          type="button"
                          class="sidebar-pages__pin"
                          ?disabled=${Boolean(snapshot)}
                          aria-label=${t("nav.pin")}
                          @click=${() => {
                            if (user.identity?.type === "profile") {
                              host.sessionOrganizer.writeSidebarEntryAt(
                                `person:${user.identity.id}`,
                                undefined,
                                undefined,
                              );
                            }
                          }}
                        >
                          ${icons.pin}
                        </button>`
                      : nothing
                  }
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
