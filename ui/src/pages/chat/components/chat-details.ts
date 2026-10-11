import type WaDropdown from "@awesome.me/webawesome/dist/components/dropdown/dropdown.js";
import { html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { keyed } from "lit/directives/keyed.js";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import { OpenClawLightDomElement } from "../../../lit/openclaw-element.ts";
import type { ChatDetailsProps } from "./chat-details-types.ts";
import "./chat-details-session.ts";
import "./chat-details-progress.ts";
import "../../../styles/chat/details.css";

/** User-opened, pane-local presentation. Data and mutations remain with the pane. */
export class ChatDetails extends OpenClawLightDomElement {
  private static nextId = 0;
  @property({ attribute: false }) props?: ChatDetailsProps;
  @property({ type: Boolean }) presented = false;
  @state() private opened = false;
  private identity = "";
  private scope?: object;
  private readonly panelId = `chat-details-${++ChatDetails.nextId}`;
  private resize?: ResizeObserver;
  private observed: Element[] = [];
  private get panel() {
    return this.querySelector<HTMLElement>(".chat-details");
  }
  private get trigger() {
    return this.querySelector<HTMLButtonElement>(".chat-details-toggle");
  }

  private readonly position = () => {
    const panel = this.panel;
    const frame =
      this.closest(".chat-main__conversation-frame") ??
      this.closest("openclaw-chat-pane")?.querySelector(".chat-main__conversation-frame");
    const footer = frame?.querySelector(".chat-footer");
    const bounds = frame?.getBoundingClientRect();
    if (!panel || !bounds) {
      return;
    }
    const viewport = window.visualViewport;
    const minimumTop = Math.max(bounds.top + 8, (viewport?.offsetTop ?? 0) + 8);
    const left = Math.max(bounds.left + 8, (viewport?.offsetLeft ?? 0) + 8);
    const right = Math.min(
      bounds.right - 8,
      (viewport?.offsetLeft ?? 0) + (viewport?.width ?? window.innerWidth) - 8,
    );
    const bottom =
      Math.min(
        footer?.getBoundingClientRect().top ?? bounds.bottom,
        bounds.bottom,
        (viewport?.offsetTop ?? 0) + (viewport?.height ?? window.innerHeight),
      ) - 8;
    const triggerBounds = this.trigger?.getBoundingClientRect();
    // Retain the gutter clearance when the trigger sits above the conversation.
    const triggerBottom = triggerBounds
      ? Math.max(triggerBounds.bottom, minimumTop + triggerBounds.height)
      : minimumTop + 28;
    const top = Math.max(minimumTop, Math.min(triggerBottom + 6, bottom - 120));
    panel.style.left = `${Math.max(left, right - 352)}px`;
    panel.style.top = `${top}px`;
    panel.style.width = `${Math.max(0, Math.min(352, right - left))}px`;
    panel.style.maxHeight = `${Math.max(0, bottom - top)}px`;
  };

  private close(restoreFocus = false) {
    for (const menu of this.querySelectorAll<WaDropdown>("wa-dropdown")) {
      menu.open = false;
    }
    if (this.panel?.isConnected) {
      this.panel.hidePopover?.();
    }
    this.opened = false;
    if (restoreFocus && this.isConnected) {
      this.trigger?.focus({ preventScroll: true });
    }
  }
  private readonly toggle = () => {
    if (this.opened) {
      this.close();
      return;
    }
    if (!this.presented) {
      return;
    }
    this.position();
    this.panel?.showPopover?.();
    this.opened = true;
  };
  private readonly outside = (event: PointerEvent) => {
    if (this.opened && !event.composedPath().includes(this)) {
      this.close();
    }
  };
  private readonly escape = (event: KeyboardEvent) => {
    if (
      event.key === "Escape" &&
      this.opened &&
      !event.defaultPrevented &&
      !this.querySelector("wa-dropdown[open]")
    ) {
      event.preventDefault();
      this.close(true);
    }
  };
  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener("resize", this.position);
    window.visualViewport?.addEventListener("resize", this.position);
    window.visualViewport?.addEventListener("scroll", this.position);
    document.addEventListener("pointerdown", this.outside);
    document.addEventListener("keydown", this.escape);
  }
  override disconnectedCallback() {
    this.close();
    this.resize?.disconnect();
    this.resize = undefined;
    this.observed = [];
    window.removeEventListener("resize", this.position);
    window.visualViewport?.removeEventListener("resize", this.position);
    window.visualViewport?.removeEventListener("scroll", this.position);
    document.removeEventListener("pointerdown", this.outside);
    document.removeEventListener("keydown", this.escape);
    super.disconnectedCallback();
  }
  protected override willUpdate(_changed: PropertyValues) {
    const identity = JSON.stringify([
      this.props?.sessionKey,
      this.props?.currentAgentId,
      this.props?.selectedSession?.sessionId,
    ]);
    if (identity !== this.identity || this.scope !== this.props?.gatewayScope || !this.presented) {
      this.close();
      this.identity = identity;
      this.scope = this.props?.gatewayScope;
    }
  }
  protected override updated() {
    if (!this.isConnected) {
      return;
    }
    const frame =
      this.closest(".chat-main__conversation-frame") ??
      this.closest("openclaw-chat-pane")?.querySelector(".chat-main__conversation-frame");
    const elements = [frame, frame?.querySelector(".chat-footer")].filter(
      (element): element is Element => Boolean(element),
    );
    if (
      elements.some((element, i) => this.observed[i] !== element) ||
      elements.length !== this.observed.length
    ) {
      this.resize?.disconnect();
      if (typeof ResizeObserver !== "undefined") {
        this.resize = new ResizeObserver(this.position);
        for (const element of elements) {
          this.resize.observe(element);
        }
      }
      this.observed = elements;
    }
    this.position();
  }
  override render() {
    const props = this.props;
    return html`<button
        class="chat-details-toggle"
        type="button"
        aria-label=${t("chat.sessionDetails.title")}
        aria-controls=${this.panelId}
        aria-expanded=${String(this.opened)}
        aria-haspopup="dialog"
        @click=${this.toggle}
      >
        ${icons.listChecks}<span>${t("chat.sessionDetails.title")}</span>
      </button>
      <div
        class="chat-details"
        id=${this.panelId}
        popover="manual"
        role="dialog"
        aria-label=${t("chat.sessionDetails.title")}
      >
        <div class="chat-details__toolbar">
          <span>${t("chat.sessionDetails.title")}</span>
          <button
            type="button"
            aria-label=${t("chat.sessionDetails.close")}
            @click=${() => this.close(true)}
          >
            ${icons.x}
          </button>
        </div>
        ${keyed(
          this.scope,
          html`<openclaw-chat-details-session
              .props=${props}
              .presented=${this.presented && this.opened}
            ></openclaw-chat-details-session>
            ${props?.progressCard || props?.progressCardInitialLoading ? html`<openclaw-chat-details-progress .props=${props} .presented=${this.presented && this.opened}></openclaw-chat-details-progress>` : nothing}`,
        )}
      </div>`;
  }
}
customElements.define("openclaw-chat-details", ChatDetails);
