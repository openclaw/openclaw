import { html, nothing } from "lit";
import { property } from "lit/decorators.js";
import { t } from "../i18n/index.ts";
import { OpenClawLightDomContentsElement } from "../lit/openclaw-element.ts";
import { icons } from "./icons.ts";
import "./tooltip.ts";

/** Sidebar identity card: the agent IS the main session. The body opens the
    agent's rolling main conversation; the trailing button opens the agent
    menu owned by app-sidebar (labeled as a switcher with 2+ agents). */
class SidebarAgentCard extends OpenClawLightDomContentsElement {
  @property({ attribute: false }) agentName = "";
  @property({ attribute: false }) avatarUrl: string | null = null;
  @property({ attribute: false }) avatarText = "";
  @property({ attribute: false }) connected = false;
  @property({ attribute: false }) statusLabel = "";
  @property({ attribute: false }) subtitle = "";
  /** The main session is the currently open chat route. */
  @property({ attribute: false }) activeSession = false;
  /** Main session has an active run; shows the working spinner. */
  @property({ attribute: false }) running = false;
  /** Main session has unread activity. */
  @property({ attribute: false }) unread = false;
  @property({ attribute: false }) menuOpen = false;
  /** Unread sessions exist on non-active agents; surfaces on the switcher. */
  @property({ attribute: false }) menuUnread = false;
  /** More than one agent is configured; single-agent setups hide the switcher. */
  @property({ attribute: false }) switcherAvailable = false;
  @property({ attribute: false }) onOpenMain?: () => void;
  @property({ attribute: false }) onToggleMenu?: (trigger: HTMLElement) => void;

  private renderState() {
    if (this.running) {
      return html`<span
        class="session-run-spinner sidebar-agent-card__state"
        role="img"
        aria-label=${t("sessionsView.activeRun")}
        title=${t("sessionsView.activeRun")}
      ></span>`;
    }
    if (this.unread) {
      return html`<span
        class="session-unread-dot sidebar-agent-card__state"
        role="img"
        aria-label=${t("sessionsView.unread")}
      ></span>`;
    }
    return nothing;
  }

  override render() {
    return html`
      <div class="sidebar-agent-card ${this.activeSession ? "sidebar-agent-card--active" : ""}">
        <button
          type="button"
          class="sidebar-agent-card__main"
          aria-current=${this.activeSession ? "page" : nothing}
          aria-label=${t("agentChip.openChat", { name: this.agentName })}
          @click=${() => this.onOpenMain?.()}
        >
          <span class="sidebar-agent-card__avatar">
            ${this.avatarUrl
              ? html`<img
                  src=${this.avatarUrl}
                  alt=""
                  aria-hidden="true"
                  loading="lazy"
                  decoding="async"
                />`
              : html`<span class="sidebar-agent-card__avatar-text" aria-hidden="true"
                  >${this.avatarText}</span
                >`}
            <span
              class="sidebar-agent-card__presence ${this.connected
                ? "sidebar-connection-status--online"
                : "sidebar-connection-status--offline"}"
              role="img"
              aria-live="polite"
              aria-label=${this.statusLabel}
              title=${this.statusLabel}
            ></span>
          </span>
          <span class="sidebar-agent-card__text">
            <span class="sidebar-agent-card__name">${this.agentName}</span>
            ${this.subtitle
              ? html`<span class="sidebar-agent-card__subtitle">${this.subtitle}</span>`
              : nothing}
          </span>
          ${this.renderState()}
        </button>
        <openclaw-tooltip
          .content=${this.switcherAvailable ? t("agentChip.switchAgent") : t("agentChip.menuLabel")}
        >
          <button
            type="button"
            class="sidebar-agent-card__switcher ${this.menuOpen
              ? "sidebar-agent-card__switcher--open"
              : ""}"
            aria-haspopup="menu"
            aria-expanded=${String(this.menuOpen)}
            aria-label=${this.switcherAvailable
              ? t("agentChip.switchAgent")
              : t("agentChip.menuLabel")}
            @click=${(event: MouseEvent) => this.onToggleMenu?.(event.currentTarget as HTMLElement)}
          >
            ${icons.chevronDown}
            ${this.menuUnread && !this.menuOpen
              ? html`<span
                  class="session-unread-dot sidebar-agent-card__switcher-unread"
                  role="img"
                  aria-label=${t("sessionsView.unread")}
                ></span>`
              : nothing}
          </button>
        </openclaw-tooltip>
      </div>
    `;
  }
}

if (!customElements.get("openclaw-sidebar-agent-card")) {
  customElements.define("openclaw-sidebar-agent-card", SidebarAgentCard);
}
