import { LitElement, html } from "lit";
import { state } from "lit/decorators.js";

export class OpenClawDemoButton extends LitElement {
  @state() private count = 0;

  override createRenderRoot() {
    return this;
  }

  override render() {
    return html`
      <button
        type="button"
        class="btn btn--sm"
        aria-label="Increment demo counter"
        @click=${this.increment}
      >
        Demo count: ${this.count}
      </button>
    `;
  }

  private increment = () => {
    this.count += 1;
  };
}

if (!customElements.get("openclaw-demo-button")) {
  customElements.define("openclaw-demo-button", OpenClawDemoButton);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-demo-button": OpenClawDemoButton;
  }
}
