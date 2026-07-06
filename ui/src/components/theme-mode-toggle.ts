import { LitElement, html } from "lit";
import { property } from "lit/decorators.js";
import type { ThemeMode } from "../app/theme.ts";
import { t } from "../i18n/index.ts";
import { icons } from "./icons.ts";
import "./tooltip.ts";

export type ThemeModeChangeDetail = {
  mode: ThemeMode;
  element: HTMLElement;
};

class ThemeModeToggle extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false }) mode: ThemeMode = "system";

  override connectedCallback() {
    super.connectedCallback();
    this.style.display = "contents";
  }

  private readonly nextMode = (): ThemeMode => {
    switch (this.mode) {
      case "system":
        return "light";
      case "light":
        return "dark";
      case "dark":
        return "system";
    }
  };

  private readonly handleModeChange = (event: Event) => {
    this.dispatchEvent(
      new CustomEvent<ThemeModeChangeDetail>("theme-change", {
        detail: { mode: this.nextMode(), element: event.currentTarget as HTMLElement },
        bubbles: true,
        composed: true,
      }),
    );
  };

  override render() {
    const labelKey =
      this.mode === "system"
        ? "common.system"
        : this.mode === "light"
          ? "common.light"
          : "common.dark";
    const label = t(labelKey);
    const tooltip = t("common.colorModeOption", { mode: label });

    return html`
      <openclaw-tooltip .content=${tooltip}>
        <button
          type="button"
          class="theme-mode-toggle"
          aria-label=${tooltip}
          @click=${this.handleModeChange}
        >
          ${this.mode === "system" ? icons.monitor : this.mode === "light" ? icons.sun : icons.moon}
        </button>
      </openclaw-tooltip>
    `;
  }
}

if (!customElements.get("openclaw-theme-mode-toggle")) {
  customElements.define("openclaw-theme-mode-toggle", ThemeModeToggle);
}
