import WaPopup from "@awesome.me/webawesome/dist/components/popup/popup.js";
import { html, nothing } from "lit";
import { property } from "lit/decorators.js";
import { isMobileNavLayout } from "../app/mobile-nav-layout.ts";
import { t } from "../i18n/index.ts";
import { occludeNativeBrowserSurface } from "../lib/native-overlay-occlusion.ts";
import { OpenClawLightDomContentsElement } from "../lit/openclaw-element.ts";
import { configureAnchoredPopup } from "./anchored-overlay.ts";
import "./menu-surface.ts";

class SidebarSessionFilterPopover extends OpenClawLightDomContentsElement {
  @property({ attribute: false }) anchor: HTMLElement | null = null;
  @property({ attribute: false }) label = "";
  @property({ attribute: false }) content: unknown = nothing;
  @property({ attribute: false }) onClose: (restoreFocus: boolean) => void = () => {};
  private focused = false;

  override connectedCallback() {
    super.connectedCallback();
    occludeNativeBrowserSurface(this);
    this.ownerDocument.addEventListener("pointerdown", this.handleOutsidePointer, true);
  }

  override disconnectedCallback() {
    this.ownerDocument.removeEventListener("pointerdown", this.handleOutsidePointer, true);
    super.disconnectedCallback();
  }

  private readonly handleOutsidePointer = (event: PointerEvent) => {
    const path = event.composedPath();
    if (!path.includes(this) && (!this.anchor || !path.includes(this.anchor))) {
      this.onClose(false);
    }
  };

  private readonly handleKeydown = (event: KeyboardEvent) => {
    if (event.key === "Escape" && !event.defaultPrevented) {
      event.preventDefault();
      event.stopPropagation();
      this.onClose(true);
    }
  };

  private readonly handleFocusOut = (event: FocusEvent) => {
    if (
      event.relatedTarget instanceof Node &&
      !this.contains(event.relatedTarget) &&
      event.relatedTarget !== this.anchor
    ) {
      this.onClose(false);
    }
  };

  protected override updated() {
    const popup = this.querySelector<WaPopup>("wa-popup");
    if (popup && this.anchor) {
      configureAnchoredPopup(popup, this.anchor, "bottom");
    } else {
      // Sheet rows are child components that render after this update.
      requestAnimationFrame(this.focusInitialControl);
    }
  }

  private readonly focusInitialControl = () => {
    if (!this.focused) {
      this.focused = true;
      this.querySelector<HTMLElement>(
        "#sidebar-sessions-owner, #sidebar-sessions-status .settings-segmented__btn--active",
      )?.focus({
        preventScroll: true,
      });
    }
  };

  protected override render() {
    // Mobile layouts present the panel as a bottom sheet, mirroring the sidebar
    // issues sheet: a backdrop that closes it, a grabber, and top-layer placement.
    const sheet = isMobileNavLayout();
    const panel = html`<div
      class="sidebar-session-filter-panel"
      role="dialog"
      aria-label=${this.label}
      aria-modal=${sheet ? "true" : nothing}
      @keydown=${this.handleKeydown}
      @focusout=${this.handleFocusOut}
    >
      <div class="sidebar-session-filter-panel__grabber" aria-hidden="true"></div>
      ${this.content}
    </div>`;
    return sheet
      ? html`<button
            type="button"
            class="sidebar-session-filter-panel__backdrop"
            aria-label=${t("common.close")}
            @click=${() => this.onClose(true)}
          ></button>
          <openclaw-menu-surface>${panel}</openclaw-menu-surface>`
      : html`<wa-popup active @wa-reposition=${this.focusInitialControl}>${panel}</wa-popup>`;
  }
}

customElements.define("openclaw-sidebar-session-filter-popover", SidebarSessionFilterPopover);
