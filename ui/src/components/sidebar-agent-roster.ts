import { html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { isSessionRouteId, pathForRoute } from "../app-route-paths.ts";
import { loadSettings, patchSettings } from "../app/settings.ts";
import { t } from "../i18n/index.ts";
import { registerAgentsHomeEnglish } from "../i18n/locales/en-agents-home.ts";
import { rosterActivityStore } from "../lib/agents/roster-activity-store.ts";
import { AgentRosterElement } from "../lib/agents/roster-element.ts";
import {
  writeSidebarAgentDragData,
  readSidebarAgentDragData,
  sidebarAgentDragActive,
} from "../lib/agents/sidebar-drag.ts";
import { orderSidebarAgents, moveSidebarAgent } from "../lib/agents/sidebar-order.ts";
import { shouldHandleNavigationClick } from "../lib/navigation-click.ts";
import { areUiSessionKeysEquivalent } from "../lib/sessions/session-key.ts";
import { SubscriptionsController } from "../lit/subscriptions-controller.ts";
import { newSessionSearch } from "../pages/new-session/location.ts";
import type { AppSidebarRenderHost } from "./app-sidebar-render.ts";
import { renderPersonalSessionEmpty } from "./app-sidebar-session-filter-summary.ts";
import { renderSessionListFrame, renderSessionSection } from "./app-sidebar-session-list-render.ts";
import type { SidebarVisibleSections } from "./app-sidebar-session-projection.ts";
import {
  renderChildSessionLoadError,
  type SessionListHost,
} from "./app-sidebar-session-row-render.ts";
import { renderSidebarSessionSectionHeader } from "./app-sidebar-session-section-header.ts";
import { icons } from "./icons.ts";
import { renderAgentIdentityAvatar } from "./identity-avatar-view.ts";
import { renderNewSessionLink } from "./new-session-link.ts";
import { renderTeamSessionSlots } from "./session-attention-presentation.ts";
import "../styles/sidebar-agent-roster.css";

registerAgentsHomeEnglish();
type RosterHost = AppSidebarRenderHost & SessionListHost;

class SidebarAgentRoster extends AgentRosterElement {
  @property({ attribute: false }) host!: RosterHost;
  @property({ attribute: false }) sections: SidebarVisibleSections["sections"] = [];
  @property({ attribute: false }) involvingMe = false;
  @state() private collapsed = new Set<string>();
  @state() private draggingAgent: string | null = null;
  @state() private agentDrop: { id: string; position: "before" | "after" } | null = null;
  @state() private orderAnnouncement = "";

  private orderedCards() {
    return orderSidebarAgents(
      this.cards(),
      this.context.navigation.snapshot.sidebarAgentOrder ?? [],
    );
  }

  private finishAgentDrag() {
    this.draggingAgent = null;
    this.agentDrop = null;
  }

  private moveAgent(source: string, target: string, position: "before" | "after") {
    const cards = this.orderedCards();
    if (
      !cards.some((card) => card.id === source) ||
      !cards.some((card) => card.id === target) ||
      source === target
    ) {
      return;
    }
    const order = moveSidebarAgent(
      this.context.navigation.snapshot.sidebarAgentOrder ?? [],
      cards.map((card) => card.id),
      source,
      target,
      position,
    );
    this.context.navigation.update({ sidebarAgentOrder: order });
    this.orderAnnouncement = t("agentsHome.agentOrderPosition", {
      agent: cards.find((card) => card.id === source)!.name,
      position: String(this.orderedCards().findIndex((card) => card.id === source) + 1),
      total: String(cards.length),
    });
    void this.updateComplete.then(() =>
      this.querySelector<HTMLButtonElement>(
        `[data-agent-group="${CSS.escape(source)}"] [slot="trigger"]`,
      )?.focus(),
    );
  }

  private moveAgentBy(id: string, direction: -1 | 1) {
    const cards = this.orderedCards();
    const target = cards[cards.findIndex((card) => card.id === id) + direction];
    if (target) {
      this.moveAgent(id, target.id, direction < 0 ? "before" : "after");
    }
  }

  private resetAgentOrder() {
    this.context.navigation.update({ sidebarAgentOrder: [] });
    this.orderAnnouncement = t("agentsHome.agentOrderReset");
  }

  private agentDragOver(event: DragEvent, id: string) {
    if (!this.draggingAgent || !sidebarAgentDragActive(event.dataTransfer)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "move";
    }
    const section = event.currentTarget;
    if (!(section instanceof HTMLElement)) {
      return;
    }
    const header = section.querySelector(".sidebar-recent-sessions__head") ?? section;
    const bounds = header.getBoundingClientRect();
    this.agentDrop = {
      id,
      position: event.clientY >= bounds.top + bounds.height / 2 ? "after" : "before",
    };
  }

  private dropAgent(event: DragEvent, id: string) {
    if (!sidebarAgentDragActive(event.dataTransfer)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const source = readSidebarAgentDragData(event.dataTransfer);
    const drop = this.agentDrop;
    this.finishAgentDrag();
    if (source && drop?.id === id) {
      this.moveAgent(source, id, drop.position);
    }
  }
  private settingsScope: string | null = null;
  private published: {
    snapshot: ReturnType<typeof rosterActivityStore>["snapshot"];
    collapsed: ReadonlySet<string>;
  } | null = null;

  constructor() {
    super();
    new SubscriptionsController(this).watch(
      () => this.context?.navigation,
      (navigation, notify) => navigation.subscribe(notify),
    );
  }

  protected override willUpdate() {
    const gatewayUrl = this.context.gateway.connection.gatewayUrl;
    if (this.settingsScope !== gatewayUrl) {
      this.settingsScope = gatewayUrl;
      this.collapsed = new Set(loadSettings(gatewayUrl).sidebarCollapsedAgentIds ?? []);
    }
    const store = rosterActivityStore(this.context);
    store.setInvolvingMe(this.involvingMe);
    const snapshot = store.snapshot;
    if (this.published?.snapshot !== snapshot || this.published.collapsed !== this.collapsed) {
      this.published = { snapshot, collapsed: this.collapsed };
      this.host.rosterSessionSource = {
        result: snapshot.result,
        agentIds: snapshot.cards.map((card) => card.id),
        collapsedAgentIds: this.collapsed,
      };
    }
  }

  override disconnectedCallback() {
    this.host.rosterSessionSource = null;
    // Agents home keeps the shared window alive after the grouped filter leaves.
    rosterActivityStore(this.context).setInvolvingMe(false);
    super.disconnectedCallback();
  }

  private toggleAgent(id: string) {
    const collapsed = new Set(this.collapsed);
    if (!collapsed.delete(id)) {
      collapsed.add(id);
    }
    this.setCollapsedAgents(collapsed);
  }

  private setCollapsedAgents(collapsed: Set<string>) {
    patchSettings(
      {
        gatewayUrl: this.context.gateway.connection.gatewayUrl,
        sidebarCollapsedAgentIds: [...collapsed],
      },
      { selectGateway: false },
    );
    this.collapsed = collapsed;
  }

  override render() {
    return this.avatars.withActiveRoutes(() => {
      const cards = this.orderedCards();
      const error = this.roster.error ?? this.roster.subscriptionError;
      const newSessionAccess = this.host.readNewSessionAccess();
      return renderSessionListFrame(
        this.host,
        html`<div class="sidebar-agent-roster">
          <span class="sr-only" role="status" aria-live="polite">${this.orderAnnouncement}</span>
          ${error ? html`<button class="sidebar-agent-roster__link" @click=${() => void this.refresh()}>${t("agentsHome.loadFailed")}</button>` : nothing}
          ${this.roster.loading && cards.length === 0 ? html`<span role="status" aria-label=${t("common.loading")} class="skeleton skeleton-line"></span>` : nothing}
          ${repeat(
            cards,
            (card) => card.id,
            (card) => {
              const collapsed = this.collapsed.has(card.id);
              const sections = this.sections.filter((section) =>
                section.id.startsWith(`agent:${card.id}:`),
              );
              const mainKey = this.host.selectedAgentMainSessionKey(card.id);
              const mainRow = this.host.mainSessionRow(card.id);
              const home = mainRow ? this.host.projectHomeSession(mainRow, card.id) : null;
              const homeLoadKeys = home?.childLoadParentKeys?.length
                ? home.childLoadParentKeys
                : [mainRow?.key ?? mainKey];
              const active =
                isSessionRouteId(this.host.activeRouteId) &&
                areUiSessionKeysEquivalent(this.host.getRouteSessionKey(), mainKey);
              const summaryRows = [
                ...(home ? [home] : []),
                ...(collapsed ? sections.flatMap((section) => section.rows) : []),
              ];
              return html`<section
                class="sidebar-agent-roster__group ${this.draggingAgent === card.id ? "sidebar-recent-sessions__group--dragging" : ""} ${this.agentDrop?.id === card.id ? `sidebar-recent-sessions__group--section-drop-${this.agentDrop.position}` : ""}"
                @dragover=${(event: DragEvent) => this.agentDragOver(event, card.id)}
                @dragleave=${(event: DragEvent) => {
                  if (
                    !(event.relatedTarget instanceof Node) ||
                    !(event.currentTarget instanceof HTMLElement) ||
                    !event.currentTarget.contains(event.relatedTarget)
                  ) {
                    this.agentDrop = null;
                  }
                }}
                @drop=${(event: DragEvent) => this.dropAgent(event, card.id)}
                data-agent-group=${card.id}
                aria-label=${card.name}
              >
                ${renderSidebarSessionSectionHeader({
                  sectionId: card.id,
                  className: "sidebar-agent-roster__header",
                  writeDragData: writeSidebarAgentDragData,
                  onStartDrag: (id) => {
                    this.draggingAgent = id;
                  },
                  onFinishDrag: () => this.finishAgentDrag(),
                  content: html`
                    <button
                      type="button"
                      class="sidebar-agent-roster__action sidebar-agent-roster__chevron"
                      data-agent-collapse=${card.id}
                      aria-label=${t(collapsed ? "agentsHome.expandAgent" : "agentsHome.collapseAgent", { agent: card.name })}
                      aria-expanded=${String(!collapsed)}
                      @click=${() => this.toggleAgent(card.id)}
                    >
                      <span class="sidebar-agent-roster__chevron" aria-hidden="true"
                        >${collapsed ? icons.chevronRight : icons.chevronDown}</span
                      >
                    </button>
                    <a
                      class="sidebar-agent-roster__row"
                      data-agent-id=${card.id}
                      href=${card.target.href}
                      aria-current=${active ? "page" : nothing}
                      title=${t("agentsHome.openChat")}
                      @click=${(event: MouseEvent) => {
                        if (shouldHandleNavigationClick(event)) {
                          event.preventDefault();
                          this.host.openMainSession(card.id);
                        }
                      }}
                    >
                      <span class="sidebar-agent-roster__avatar" aria-hidden="true">
                        ${renderAgentIdentityAvatar(card)}
                      </span>
                      <span class="sidebar-agent-roster__copy"><span>${card.name}</span></span>
                    </a>
                    <span class="sidebar-agent-roster__signals">
                      ${
                        summaryRows.length > 0
                          ? renderTeamSessionSlots(
                              summaryRows,
                              collapsed,
                              collapsed
                                ? sections.reduce(
                                    (count, section) => count + section.rows.length,
                                    0,
                                  )
                                : 0,
                              summaryRows.reduce(
                                (count, row) => count + (row.workspaceConflictCount ?? 0),
                                0,
                              ),
                            )
                          : nothing
                      }
                    </span>
                    <span
                      class="sidebar-agent-roster__actions"
                      @keydown=${(event: KeyboardEvent) => {
                        if (event.key === " " && event.target instanceof HTMLAnchorElement) {
                          event.preventDefault();
                          event.target.click();
                        }
                      }}
                    >
                      ${renderNewSessionLink({
                        basePath: this.host.basePath,
                        agentId: card.id,
                        className: "sidebar-agent-roster__action sidebar-agent-roster__new",
                        label: `${t("agentChip.newConversation")}: ${card.name}`,
                        disabledReason: newSessionAccess.allowed
                          ? undefined
                          : newSessionAccess.reason,
                        onOpen: (id, target) => this.host.requestOpenNewSession(id, target),
                      })}
                      <wa-dropdown
                        placement="bottom-end"
                        @wa-show=${() => this.host.dismissTransientMenus()}
                        @wa-select=${(
                          event: CustomEvent<{ item: HTMLElement & { value?: string } }>,
                        ) => {
                          switch (event.detail.item.value) {
                            case "move-up":
                              this.moveAgentBy(card.id, -1);
                              break;
                            case "move-down":
                              this.moveAgentBy(card.id, 1);
                              break;
                            case "reset-order":
                              this.resetAgentOrder();
                              break;
                            case "main":
                              this.host.openMainSession(card.id);
                              break;
                            case "sessions":
                              this.context.agentSelection.setScope(card.id);
                              this.host.onNavigate?.("sessions");
                              break;
                            case "collapse-others":
                              this.setCollapsedAgents(
                                new Set(
                                  cards
                                    .filter((other) => other.id !== card.id)
                                    .map((other) => other.id),
                                ),
                              );
                              break;
                            default:
                              break;
                          }
                        }}
                      >
                        <button
                          slot="trigger"
                          type="button"
                          class="sidebar-agent-roster__action"
                          aria-label=${t("agentsHome.agentOptions", { agent: card.name })}
                        >
                          ${icons.moreHorizontal}
                        </button>
                        <wa-dropdown-item value="move-up" ?disabled=${cards[0]?.id === card.id}
                          >${t("agentsHome.moveAgentUp")}</wa-dropdown-item
                        >
                        <wa-dropdown-item
                          value="move-down"
                          ?disabled=${cards.at(-1)?.id === card.id}
                          >${t("agentsHome.moveAgentDown")}</wa-dropdown-item
                        >
                        <wa-dropdown-item
                          value="reset-order"
                          ?disabled=${!this.context.navigation.snapshot.sidebarAgentOrder?.length}
                          >${t("agentsHome.resetAgentOrder")}</wa-dropdown-item
                        >
                        <wa-dropdown-item value="main"
                          >${t("agentsHome.openMainChat")}</wa-dropdown-item
                        >
                        <wa-dropdown-item value="sessions"
                          >${t("agentsHome.allSessions")}</wa-dropdown-item
                        >
                        <wa-dropdown-item value="collapse-others"
                          >${t("agentsHome.collapseOthers")}</wa-dropdown-item
                        >
                      </wa-dropdown>
                    </span>
                  `,
                })}
                ${
                  collapsed
                    ? nothing
                    : html`${homeLoadKeys.map((key) => renderChildSessionLoadError(this.host, key))}
                      ${sections.map((section) =>
                        renderSessionSection({
                          host: this.host,
                          section,
                          personHeaders: undefined,
                        }),
                      )}`
                }
              </section>`;
            },
          )}
          ${renderPersonalSessionEmpty(
            this.host,
            this.sections.every((section) => section.totalRowCount === 0),
            this.connected &&
              this.roster.result !== null &&
              !this.roster.loading &&
              !error &&
              !this.roster.result.hasMore &&
              !this.host.sessionData.sessionMutationError,
          )}
        </div>`,
      );
    });
  }
}

customElements.define("openclaw-sidebar-agent-roster", SidebarAgentRoster);

class SidebarNewSessionMenu extends AgentRosterElement {
  @property({ attribute: false }) host!: RosterHost;
  @property({ attribute: false }) triggerClass = "";

  override render() {
    return this.avatars.withActiveRoutes(() => {
      const access = this.host.readNewSessionAccess();
      const cards = this.cards();
      return html`<wa-dropdown
        class="sidebar-new-session-menu"
        placement="bottom-end"
        aria-label=${t("agentChip.agents")}
        @wa-show=${() => this.host.dismissTransientMenus()}
        @wa-select=${(event: CustomEvent<{ item: HTMLElement & { value?: string } }>) => {
          const item = event.detail.item;
          event.preventDefault();
          if (item.dataset.nativeNavigation) {
            delete item.dataset.nativeNavigation;
            return;
          }
          const id = item.value;
          if (access.allowed && id && cards.some((card) => card.id === id)) {
            const dropdown = this.querySelector("wa-dropdown");
            if (dropdown) {
              dropdown.open = false;
            }
            this.host.requestOpenNewSession(id);
          }
        }}
      >
        <button
          slot="trigger"
          type="button"
          class=${this.triggerClass}
          aria-label=${t("agentChip.newConversation")}
          title=${access.allowed ? t("agentChip.newConversation") : access.reason}
          ?disabled=${!access.allowed || cards.length === 0}
        >
          ${icons.plus}
        </button>
        ${cards.map(
          (card) => html`<wa-dropdown-item
            value=${card.id}
            @click=${(event: MouseEvent) => {
              if (shouldHandleNavigationClick(event)) {
                event.preventDefault();
              } else if (event.currentTarget instanceof HTMLElement) {
                event.currentTarget.dataset.nativeNavigation = "true";
              }
            }}
            ><a
              class="sidebar-agent-roster__link"
              href=${`${pathForRoute("new-session", this.host.basePath)}${newSessionSearch(card.id)}`}
              tabindex="-1"
              ><span class="sidebar-agent-roster__avatar" aria-hidden="true">
                ${renderAgentIdentityAvatar(card)} </span
              ><span>${card.name}</span></a
            >
          </wa-dropdown-item>`,
        )}
      </wa-dropdown>`;
    });
  }
}

customElements.define("openclaw-sidebar-new-session-menu", SidebarNewSessionMenu);

export function renderSidebarNewSessionMenu(host: RosterHost, triggerClass: string) {
  return html`<openclaw-sidebar-new-session-menu
    .host=${host}
    .active=${host.navigationVisible}
    .triggerClass=${triggerClass}
  ></openclaw-sidebar-new-session-menu>`;
}

export function renderSidebarAgentRoster(
  host: RosterHost,
  sections: SidebarVisibleSections["sections"],
) {
  return html`<openclaw-sidebar-agent-roster
    .host=${host}
    .active=${host.navigationVisible}
    .sections=${sections}
    .involvingMe=${host.sessionInvolvingMeFilterActive}
  ></openclaw-sidebar-agent-roster>`;
}
