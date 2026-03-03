import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";

@customElement("response-chips")
export class ResponseChips extends LitElement {
  @property({ type: Array })
  options: string[] = [];

  static styles = css`
    :host {
      display: flex;
      gap: 8px;
      margin-top: 8px;
      flex-wrap: wrap;
    }

    button {
      padding: 4px 10px;
      border-radius: 16px;
      border: 1px solid var(--border, #ccc);
      background: var(--muted, #f5f5f5);
      cursor: pointer;
      font-size: 12px;
    }

    button:hover {
      background: var(--accent, #e6f0ff);
    }
  `;

  private select(token: string) {
    this.dispatchEvent(
      new CustomEvent("response-selected", {
        detail: token,
        bubbles: true,
        composed: true,
      }),
    );
  }

  render() {
    return html`
      ${this.options.map(
        (opt) => html`
          <button @click=${() => this.select(opt)}>
            ${opt}
          </button>
        `,
      )}
    `;
  }
}
