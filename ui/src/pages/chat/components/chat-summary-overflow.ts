import { html, type PropertyValues } from "lit";
import { property } from "lit/decorators.js";
import { OpenClawLightDomElement } from "../../../lit/openclaw-element.ts";

/** Fade only measured overflow; the unabridged string remains accessible. */
export class ChatSummaryOverflow extends OpenClawLightDomElement {
  @property() text = "";
  private observer?: ResizeObserver;
  private readonly measure = () => {
    this.toggleAttribute("data-overflow", this.scrollWidth > this.clientWidth + 1);
  };
  override connectedCallback() {
    super.connectedCallback();
    if (typeof ResizeObserver !== "undefined") {
      this.observer = new ResizeObserver(this.measure);
      this.observer.observe(this);
    }
    document.fonts?.addEventListener("loadingdone", this.measure);
  }
  override disconnectedCallback() {
    this.observer?.disconnect();
    document.fonts?.removeEventListener("loadingdone", this.measure);
    super.disconnectedCallback();
  }
  protected override updated(_changed: PropertyValues) {
    this.title = this.text;
    this.measure();
  }
  override render() {
    return html`${this.text}`;
  }
}
customElements.define("openclaw-summary-overflow", ChatSummaryOverflow);
