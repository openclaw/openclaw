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

export class ThemeModeToggle extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false }) mode: ThemeMode = "system";

  override connectedCallback() {
    super.connectedCallback();
    this.style.display = "contents";
  }

  private readonly handleModeChange = (mode: ThemeMode, event: Event) => {
    if (mode === this.mode) {
      return;
    }
    this.dispatchEvent(
      new CustomEvent<ThemeModeChangeDetail>("theme-change", {
        detail: { mode, element: event.currentTarget as HTMLElement },
        bubbles: true,
        composed: true,
      }),
    );
  };

  override render() {
    const options: Array<{ id: ThemeMode; labelKey: string }> = [
      { id: "system", labelKey: "common.system" },
      { id: "light", labelKey: "common.light" },
      { id: "dark", labelKey: "common.dark" },
    ];

    return html`
      <div class="topbar-theme-mode" role="group" aria-label=${t("common.colorMode")}>
        ${options.map((option) => {
          const label = t(option.labelKey);
          const tooltip = t("common.colorModeOption", { mode: label });
          return html`
            <openclaw-tooltip .content=${tooltip}>
              <button
                type="button"
                class="topbar-theme-mode__btn ${option.id === this.mode
                  ? "topbar-theme-mode__btn--active"
                  : ""}"
                aria-label=${tooltip}
                aria-pressed=${option.id === this.mode}
                @click=${(event: Event) => this.handleModeChange(option.id, event)}
              >
                ${option.id === "system"
                  ? icons.monitor
                  : option.id === "light"
                    ? icons.sun
                    : icons.moon}
              </button>
            </openclaw-tooltip>
          `;
        })}
      </div>
    `;
  }
}

if (!customElements.get("openclaw-theme-mode-toggle")) {
  customElements.define("openclaw-theme-mode-toggle", ThemeModeToggle);
}
