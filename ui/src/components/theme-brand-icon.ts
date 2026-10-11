import { css, html, LitElement, type TemplateResult } from "lit";
import { property } from "lit/decorators.js";
import type { ThemeBranding } from "../../../packages/gateway-protocol/src/theme.ts";
import { currentThemeBranding } from "../app/theme-branding.ts";
import { icons } from "./icons.ts";
import { renderPluginThemeArtwork } from "./plugin-theme-artwork.ts";

/** Keep validated plugin artwork inside a sized shadow root on every brand surface. */
class ThemeBrandIcon extends LitElement {
  static override styles = css`
    :host {
      display: inline-flex;
      width: 100%;
      height: 100%;
    }
    img,
    svg {
      display: block;
      width: 100%;
      height: 100%;
      object-fit: contain;
    }
  `;
  @property({ attribute: false }) branding?: ThemeBranding;
  override render() {
    const branding = this.branding ?? currentThemeBranding();
    const artwork = branding.artwork?.icons?.[branding.brandIcon];
    return artwork ? renderPluginThemeArtwork(artwork.url, "brand-icon", icons.mark) : icons.mark;
  }
}
if (!customElements.get("openclaw-theme-brand-icon")) {
  customElements.define("openclaw-theme-brand-icon", ThemeBrandIcon);
}

export function renderThemeBrandIcon(
  claw: TemplateResult = icons.lobster,
  branding: ThemeBranding = currentThemeBranding(),
  neutral: TemplateResult = icons.mark,
) {
  if (branding.brandIcon === "claw") {
    return claw;
  }
  if (branding.brandIcon === "mark") {
    return neutral;
  }
  return html`<openclaw-theme-brand-icon
    .branding=${branding}
    aria-hidden="true"
  ></openclaw-theme-brand-icon>`;
}

export type { ThemeBrandIcon };

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-theme-brand-icon": HTMLAttributes<ThemeBrandIcon> & {
        "prop:branding"?: ThemeBranding;
      };
    }
  }
}
