import { html, nothing } from "lit";
import { property } from "lit/decorators.js";
import { t } from "../i18n/index.ts";
import { OpenClawLightDomContentsElement } from "../lit/openclaw-element.ts";
import { icons } from "./icons.ts";
import "./tooltip.ts";

/** Sidebar footer identity chip: the beginner-facing entrance to the active
    agent. The body resumes the agent's latest conversation; the trailing
    controls create a session or open the utility menu owned by app-sidebar. */
class SidebarAgentChip extends OpenClawLightDomContentsElement {
  @property({ attribute: false }) agentName = "";
  @property({ attribute: false }) avatarUrl: string | null = null;
  @property({ attribute: false }) avatarText = "";
  @property({ attribute: false }) connected = false;
  @property({ attribute: false }) statusLabel = "";
  @property({ attribute: false }) subtitle = "";
  @property({ attribute: false }) menuOpen = false;
  @property({ attribute: false }) newSessionDisabled = false;
  @property({ attribute: false }) onOpenConversation?: () => void;
  @property({ attribute: false }) onNewSession?: () => void;
  @property({ attribute: false }) onToggleMenu?: (trigger: HTMLElement) => void;

  override render() {
    return html`
      <div class="sidebar-agent-chip">
        <button
          type="button"
          class="sidebar-agent-chip__main"
          aria-label=${t("agentChip.openConversation", { name: this.agentName })}
          @click=${() => this.onOpenConversation?.()}
        >
          <span class="sidebar-agent-chip__avatar">
            ${this.avatarUrl
              ? html`<img
                  src=${this.avatarUrl}
                  alt=""
                  aria-hidden="true"
                  loading="lazy"
                  decoding="async"
                />`
              : html`<span class="sidebar-agent-chip__avatar-text" aria-hidden="true"
                  >${this.avatarText}</span
                >`}
            <span
              class="sidebar-agent-chip__presence ${this.connected
                ? "sidebar-connection-status--online"
                : "sidebar-connection-status--offline"}"
              role="img"
              aria-live="polite"
              aria-label=${this.statusLabel}
              title=${this.statusLabel}
            ></span>
          </span>
          <span class="sidebar-agent-chip__text">
            <span class="sidebar-agent-chip__name">${this.agentName}</span>
            ${this.subtitle
              ? html`<span class="sidebar-agent-chip__subtitle">${this.subtitle}</span>`
              : nothing}
          </span>
        </button>
        <openclaw-tooltip .content=${t("chat.runControls.newSession")}>
          <button
            type="button"
            class="sidebar-agent-chip__action"
            aria-label=${t("chat.runControls.newSession")}
            ?disabled=${this.newSessionDisabled}
            @click=${() => this.onNewSession?.()}
          >
            ${icons.plus}
          </button>
        </openclaw-tooltip>
        <button
          type="button"
          class="sidebar-agent-chip__action sidebar-agent-chip__menu-toggle ${this.menuOpen
            ? "sidebar-agent-chip__menu-toggle--open"
            : ""}"
          aria-label=${t("agentChip.menuLabel")}
          aria-haspopup="menu"
          aria-expanded=${String(this.menuOpen)}
          @click=${(event: MouseEvent) => this.onToggleMenu?.(event.currentTarget as HTMLElement)}
        >
          ${icons.chevronDown}
        </button>
      </div>
    `;
  }
}

customElements.define("openclaw-sidebar-agent-chip", SidebarAgentChip);
