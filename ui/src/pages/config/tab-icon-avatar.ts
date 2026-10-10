import type { JSX as SolidJSX } from "@solidjs/web";
import { html } from "lit";
import { property } from "lit/decorators.js";
import type { AgentTabIconShape } from "../../../../packages/gateway-protocol/src/schema/tab-icon.ts";
import { currentThemeBranding, subscribeThemeBranding } from "../../app/theme-branding.ts";
import {
  identityAvatarClass,
  renderIdentityAvatarImage,
} from "../../components/identity-avatar-view.ts";
import { renderThemeBrandIcon } from "../../components/theme-brand-icon.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";

/** The unported avatar owner retains authenticated image resources for this leaf. */
class TabIconAvatar extends OpenClawLightDomElement {
  @property({ attribute: false }) imageUrl: string | null = null;
  @property({ attribute: false }) shape: AgentTabIconShape = "square";
  @property({ attribute: false }) fallbackUrl = "";
  @property({ attribute: false }) fallbackOnly = false;

  private stopBranding?: () => void;

  override connectedCallback() {
    super.connectedCallback();
    this.stopBranding = subscribeThemeBranding(() => this.requestUpdate());
  }

  override disconnectedCallback() {
    this.stopBranding?.();
    this.stopBranding = undefined;
    super.disconnectedCallback();
  }

  protected render() {
    const view = { imageUrl: this.imageUrl, pending: false };
    const fallback = html`<img src=${this.fallbackUrl} alt="" />`;
    if (this.fallbackOnly) {
      return renderThemeBrandIcon(fallback, currentThemeBranding(), fallback);
    }
    return html`<span
      class=${identityAvatarClass("identity-avatar--agent settings-tab-icon__preview", view)}
      data-avatar-shape=${this.shape}
      aria-hidden="true"
    >
      ${renderIdentityAvatarImage({
        view,
        fallbackSelector: ".settings-tab-icon__preview",
        className: "identity-avatar__image",
      })}
      <span class="identity-avatar__fallback"
        >${renderThemeBrandIcon(fallback, currentThemeBranding(), fallback)}</span
      >
    </span>`;
  }
}

if (!customElements.get("openclaw-tab-icon-avatar")) {
  customElements.define("openclaw-tab-icon-avatar", TabIconAvatar);
}

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-tab-icon-avatar": SolidJSX.HTMLAttributes<HTMLElement> & {
        "prop:imageUrl": string | null;
        "prop:shape"?: AgentTabIconShape;
        "prop:fallbackUrl": string;
        "prop:fallbackOnly"?: boolean;
      };
    }
  }
}
