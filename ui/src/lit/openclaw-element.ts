import { LitElement } from "lit";
import { I18nController } from "../i18n/lib/lit-controller.ts";

/** Light-DOM element whose host should not add a layout box around its render output. */
export abstract class OpenClawLightDomContentsElement extends LitElement {
  protected readonly i18nController = new I18nController(this);

  override createRenderRoot() {
    return this;
  }

  override connectedCallback() {
    super.connectedCallback();
    this.style.display = "contents";
  }
}
