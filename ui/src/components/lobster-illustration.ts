import { property } from "lit/decorators.js";
import { OpenClawLightDomElement } from "../lit/openclaw-element.ts";
import type { LobsterPetLook } from "./lobster-pet-contract.ts";
import { renderLobsterSvg } from "./lobster-pet-look.ts";

/** Keeps the unported sprite geometry under one Lit owner inside Solid pages. */
export class LobsterIllustration extends OpenClawLightDomElement {
  @property({ attribute: false }) look!: LobsterPetLook;
  @property({ attribute: false }) options: Parameters<typeof renderLobsterSvg>[1] = {};

  protected render() {
    return renderLobsterSvg(this.look, this.options);
  }
}

if (!customElements.get("openclaw-lobster-illustration")) {
  customElements.define("openclaw-lobster-illustration", LobsterIllustration);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-lobster-illustration": LobsterIllustration;
  }
}

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-lobster-illustration": JSX.HTMLAttributes<LobsterIllustration> & {
        "prop:look": LobsterPetLook;
        "prop:options"?: Parameters<typeof renderLobsterSvg>[1];
      };
    }
  }
}
