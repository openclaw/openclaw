import { css, html } from "lit";
import { property, state } from "lit/decorators.js";
import {
  normalizeSessionColorValue,
  normalizeSessionIconValue,
} from "../../../packages/gateway-protocol/src/session-agent-status.js";
import type {
  ControlUiAppearanceGlyphProps,
  ControlUiAppearancePickerProps,
} from "../../../src/plugin-sdk/control-ui-components.js";
import { OpenClawLightDomElement, OpenClawLitElement } from "../lit/openclaw-element.ts";
import { resolveSessionIconGlyph } from "./session-icon-glyph-registry.ts";
import { handleAppearanceGridKeydown, renderAppearancePicker } from "./session-icon-picker.ts";
import "../styles/sidebar-menus.css";

export class AppearancePicker extends OpenClawLightDomElement {
  @property({ attribute: false }) props!: ControlUiAppearancePickerProps;
  @state() private mode: "grid" | "custom" = "grid";
  @state() private customIcon = "";

  private select(icon: string | null, color: string | null) {
    if (!this.props.disabled) {
      this.props.onChange({ icon, color });
    }
  }

  private showGrid() {
    this.mode = "grid";
    this.customIcon = "";
    void this.updateComplete.then(() => {
      if (this.isConnected) {
        this.querySelector<HTMLElement>(".session-menu__icon-choice--custom")?.focus();
      }
    });
  }

  override render() {
    return renderAppearancePicker({
      inline: true,
      clearable: this.props.clearable,
      mode: this.mode,
      currentIcon: this.props.icon,
      currentColor: this.props.color,
      disabled: this.props.disabled ?? false,
      colorDisabled: this.props.disabled ?? false,
      customIconValue: this.customIcon,
      onSelectColor: (_event, color) => this.select(this.props.icon, color),
      onSelect: (_event, icon) => this.select(icon, this.props.color),
      onReset: () => this.select(null, null),
      onShowCustom: () => {
        this.mode = "custom";
        this.customIcon = "";
        void this.updateComplete.then(() => {
          if (this.isConnected) {
            this.querySelector<HTMLInputElement>(".session-menu__icon-custom-input")?.focus();
          }
        });
      },
      onBack: () => this.showGrid(),
      onInput: (event) => {
        if (event.currentTarget instanceof HTMLInputElement) {
          this.customIcon = event.currentTarget.value;
        }
      },
      onApply: () => {
        const icon = normalizeSessionIconValue(this.customIcon);
        if (icon && !this.props.disabled) {
          this.select(icon, this.props.color);
          this.showGrid();
        }
      },
      onGridKeydown: handleAppearanceGridKeydown,
    });
  }
}

export class AppearanceGlyph extends OpenClawLitElement {
  @property({ attribute: false }) props!: ControlUiAppearanceGlyphProps;

  static override styles = css`
    :host {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 1em;
      height: 1em;
    }
    svg {
      width: 100%;
      height: 100%;
    }
  `;

  get colorCss() {
    const color = normalizeSessionColorValue(this.props.color ?? "");
    if (color) {
      return `var(--session-color-${color})`;
    }
    const raw = this.props.color?.trim() ?? "";
    return /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/iu.test(raw) ? raw : "";
  }

  override render() {
    const icon = this.props.icon?.trim();
    return html`${icon ? (resolveSessionIconGlyph(icon) ?? icon) : this.props.fallback}`;
  }
}

if (!customElements.get("openclaw-appearance-picker")) {
  customElements.define("openclaw-appearance-picker", AppearancePicker);
}
if (!customElements.get("openclaw-appearance-glyph")) {
  customElements.define("openclaw-appearance-glyph", AppearanceGlyph);
}
