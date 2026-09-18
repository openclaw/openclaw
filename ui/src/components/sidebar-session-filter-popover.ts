import WaPopup from "@awesome.me/webawesome/dist/components/popup/popup.js";
import { html, nothing, type PropertyValues } from "lit";
import { property } from "lit/decorators.js";
import { occludeNativeBrowserSurface } from "../lib/native-overlay-occlusion.ts";
import { OpenClawLightDomContentsElement } from "../lit/openclaw-element.ts";
import { configureAnchoredPopup } from "./anchored-overlay.ts";
import type { SelectPicker } from "./select-picker.ts";

class SidebarSessionFilterPopover extends OpenClawLightDomContentsElement {
  @property({ attribute: false }) anchor: HTMLElement | null = null;
  @property({ attribute: false }) label = "";
  @property({ attribute: false }) view: "root" | "filters" | "view" = "root";
  @property({ attribute: false }) content: unknown = nothing;
  @property({ attribute: false }) onBack: () => void = () => {};
  @property({ attribute: false }) onClose: (restoreFocus: boolean) => void = () => {};
  private focused = false;
  private readonly focusByView = new Map<string, string>();

  override connectedCallback() {
    super.connectedCallback();
    occludeNativeBrowserSurface(this);
    this.ownerDocument.addEventListener("pointerdown", this.handleOutsidePointer, true);
    this.addEventListener("keydown", this.handleMenuNavigation, true);
  }

  override disconnectedCallback() {
    this.ownerDocument.removeEventListener("pointerdown", this.handleOutsidePointer, true);
    this.removeEventListener("keydown", this.handleMenuNavigation, true);
    super.disconnectedCallback();
  }

  private items() {
    return [
      ...this.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemcheckbox"]'),
    ].filter(
      (item) => !item.closest(".sidebar-session-owner-picker") && !item.hasAttribute("disabled"),
    );
  }

  private focusItem(item: HTMLElement | undefined) {
    for (const candidate of this.items()) {
      candidate.tabIndex = candidate === item ? 0 : -1;
    }
    item?.focus({ preventScroll: true });
    item?.scrollIntoView({ block: "nearest" });
  }

  private readonly handleOutsidePointer = (event: PointerEvent) => {
    const path = event.composedPath();
    if (!path.includes(this) && (!this.anchor || !path.includes(this.anchor))) {
      this.onClose(false);
    }
  };

  private readonly handleMenuNavigation = (event: KeyboardEvent) => {
    const items = this.items();
    const index = items.findIndex((item) => event.composedPath().includes(item));
    if (index < 0) {
      return;
    }
    const forward = getComputedStyle(this).direction === "rtl" ? "ArrowLeft" : "ArrowRight";
    const backward = forward === "ArrowRight" ? "ArrowLeft" : "ArrowRight";
    let next: number | undefined;
    if (event.key === "ArrowDown") {
      next = (index + 1) % items.length;
    } else if (event.key === "ArrowUp") {
      next = (index + items.length - 1) % items.length;
    } else if (event.key === "Home") {
      next = 0;
    } else if (event.key === "End") {
      next = items.length - 1;
    } else if (event.key === forward && items[index]?.getAttribute("aria-haspopup")) {
      items[index]?.click();
    } else if (event.key === backward && this.view !== "root") {
      this.onBack();
    } else if (event.key === "Tab") {
      this.anchor?.focus();
      this.onClose(false);
      return;
    } else {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (next !== undefined) {
      this.focusItem(items[next]);
    }
  };

  private readonly handleKeydown = (event: KeyboardEvent) => {
    if (event.key === "Escape" && !event.defaultPrevented) {
      event.preventDefault();
      event.stopPropagation();
      if (this.view === "root") {
        this.onClose(true);
      } else {
        this.onBack();
      }
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

  protected override willUpdate(changed: PropertyValues<this>) {
    const previous = changed.get("view");
    const active = this.ownerDocument.activeElement;
    if (previous && active instanceof HTMLElement && this.contains(active)) {
      this.focusByView.set(previous, active.id);
    }
  }

  protected override updated(changed: PropertyValues<this>) {
    const popup = this.querySelector<WaPopup>("wa-popup");
    if (popup && this.anchor) {
      configureAnchoredPopup(popup, this.anchor, "bottom");
    }
    if (changed.has("view") && this.focused) {
      const view = this.view;
      void Promise.all(
        [...this.querySelectorAll<SelectPicker>("openclaw-select-picker")].map(
          (picker) => picker.updateComplete,
        ),
      ).then(() => {
        if (this.isConnected && this.view === view) {
          const items = this.items();
          const previousId = this.focusByView.get(view);
          this.focusItem(
            items.find((item) => item.id === previousId) ??
              items.find((item) => item.id !== "sidebar-sessions-back") ??
              items[0],
          );
        }
      });
    }
  }

  private readonly focusInitialControl = () => {
    if (!this.focused) {
      this.focused = true;
      this.focusItem(this.items()[0]);
    }
  };

  protected override render() {
    return html`<wa-popup active @wa-reposition=${this.focusInitialControl}>
      <div
        class="sidebar-session-filter-panel"
        role="menu"
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
