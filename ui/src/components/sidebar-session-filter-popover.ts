import WaPopup from "@awesome.me/webawesome/dist/components/popup/popup.js";
import { html, nothing } from "lit";
import { property } from "lit/decorators.js";
import { occludeNativeBrowserSurface } from "../lib/native-overlay-occlusion.ts";
import { OpenClawLightDomContentsElement } from "../lit/openclaw-element.ts";
import { configureAnchoredPopup } from "./anchored-overlay.ts";

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
    }
  }

  private readonly focusInitialControl = () => {
    if (!this.focused) {
      this.focused = true;
      const first =
        this.querySelector<HTMLElement>('button[tabindex="0"]') ??
        this.querySelector<HTMLElement>("button");
      first?.focus();
    }
  };

  protected override render() {
    return html`<wa-popup active @wa-reposition=${this.focusInitialControl}>
      <div
        class="filter-popover__panel sidebar-session-filter-panel"
        role="dialog"
        aria-label=${this.label}
        @keydown=${this.handleKeydown}
        @focusout=${this.handleFocusOut}
      >
        ${this.content}
      </div>
    </wa-popup>`;
  }
}

customElements.define("openclaw-sidebar-session-filter-popover", SidebarSessionFilterPopover);
