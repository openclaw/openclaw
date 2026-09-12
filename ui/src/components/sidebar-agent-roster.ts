import { html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { pathForRoute } from "../app-route-paths.ts";
import { loadSettings, patchSettings } from "../app/settings.ts";
import { t } from "../i18n/index.ts";
import { registerAgentsHomeEnglish } from "../i18n/locales/en-agents-home.ts";
import { rosterActivityStore } from "../lib/agents/roster-activity-store.ts";
import { AgentRosterElement } from "../lib/agents/roster-element.ts";
import { shouldHandleNavigationClick } from "../lib/navigation-click.ts";
import { newSessionSearch } from "../pages/new-session/location.ts";
import type { AppSidebarRenderHost } from "./app-sidebar-render.ts";
import { renderSessionListFrame, renderSessionSection } from "./app-sidebar-session-list-render.ts";
import type { SidebarVisibleSections } from "./app-sidebar-session-projection.ts";
import {
  renderSidebarSessionIndicators,
  type SessionListHost,
} from "./app-sidebar-session-row-render.ts";
import { icons } from "./icons.ts";
import { renderAgentAvatarFallback } from "./identity-avatar-view.ts";
import { renderNewSessionLink } from "./new-session-link.ts";
import {
  renderCompactSessionAttention,
  renderSessionTreeSummary,
} from "./session-attention-presentation.ts";
import { renderSessionRowBadges } from "./session-row-badges.ts";
import "../styles/sidebar-agent-roster.css";

registerAgentsHomeEnglish();
type RosterHost = AppSidebarRenderHost &
  SessionListHost & { loadMoreSidebarSessions(): Promise<void> };

class SidebarAgentRoster extends AgentRosterElement {
  @property({ attribute: false }) host!: RosterHost;
  @property({ attribute: false }) sections: SidebarVisibleSections["sections"] = [];
  @property({ attribute: false }) involvingMe = false;
  @state() private collapsed = new Set<string>();
  private settingsScope: string | null = null;
  private published: {
    snapshot: ReturnType<typeof rosterActivityStore>["snapshot"];
    collapsed: ReadonlySet<string>;
  } | null = null;

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
      const cards = this.cards();
      const error = this.roster.error ?? this.roster.subscriptionError;
      const newSessionAccess = this.host.readNewSessionAccess();
      const seeAll = html`<a
        class="sidebar-agent-roster__link"
        href=${pathForRoute("agents-home", this.host.basePath)}
        @click=${(event: MouseEvent) => {
          if (shouldHandleNavigationClick(event)) {
            event.preventDefault();
            this.host.onNavigate?.("agents-home");
          }
        }}
        >${t("agentsHome.seeAll")}</a
      >`;
      return renderSessionListFrame(
        this.host,
        html`<div class="sidebar-agent-roster">
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
              const main = this.host.mainSessionRow(card.id);
              const mainSession = main
                ? this.host.getSessionNavigationState().toSidebarSession(main)
                : null;
              const summaryRows = collapsed ? sections.flatMap((section) => section.rows) : [];
              return html`<section
                class="sidebar-agent-roster__group"
                data-agent-group=${card.id}
                aria-label=${card.name}
              >
                <div class="sidebar-agent-roster__header">
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
                    title=${t("agentsHome.openChat")}
                    @click=${(event: MouseEvent) => {
                      if (shouldHandleNavigationClick(event)) {
                        event.preventDefault();
                        this.host.openMainSession(card.id);
                      }
                    }}
                  >
                    <span class="sidebar-agent-roster__avatar" aria-hidden="true">
                      ${card.avatar ? html`<img src=${card.avatar} alt="" loading="lazy" />` : (card.textAvatar ?? renderAgentAvatarFallback(card.id))}
                    </span>
                    <span class="sidebar-agent-roster__copy"><span>${card.name}</span></span>
                  </a>
                  <span class="sidebar-agent-roster__signals">
                    ${renderSessionTreeSummary(summaryRows)}
                    ${
                      mainSession
                        ? renderSidebarSessionIndicators(this.host, mainSession).content
                        : html`
                            <openclaw-viewer-facepile
                              .presencePayload=${this.host.sessionData.presencePayload}
                              .selfUser=${this.host.sessionDataContext?.gateway.snapshot.selfUser}
                              .selfInstanceId=${this.host.sessionData.presenceInstanceId}
                              .sessionKey=${card.mainKey}
                              .maxVisible=${3}
                              variant="session"
                            ></openclaw-viewer-facepile>
                            ${renderCompactSessionAttention(this.host.resolveHomeSessionAttention(card.mainKey, main))}
                            ${renderSessionRowBadges({ outboxAttentionCount: this.host.outboxAttentionCountForSession(card.mainKey), hasComposerDraft: this.host.hasSessionDraft(card.mainKey) })}
                          `
                    }
                  </span>
                  ${renderNewSessionLink({
                    basePath: this.host.basePath,
                    agentId: card.id,
                    className: "sidebar-agent-roster__action sidebar-agent-roster__new",
                    label: `${t("chat.runControls.newSession")}: ${card.name}`,
                    disabledReason: newSessionAccess.allowed ? undefined : newSessionAccess.reason,
                    onOpen: (id, target) => this.host.requestOpenNewSession(id, target),
                  })}
                </div>
                ${
                  collapsed
                    ? nothing
                    : sections.map((section) =>
                        renderSessionSection({
                          host: this.host,
                          section,
                          personHeaders: undefined,
                        }),
                      )
                }
              </section>`;
            },
          )}
        </div>`,
        html`${seeAll}${renderSidebarNewSessionMenu(this.host, "sidebar-session-toolbar__button sidebar-new-session")}`,
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
          aria-label=${t("chat.runControls.newSession")}
          title=${access.allowed ? t("chat.runControls.newSession") : access.reason}
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
                ${card.avatar ? html`<img src=${card.avatar} alt="" loading="lazy" />` : (card.textAvatar ?? renderAgentAvatarFallback(card.id))} </span
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
