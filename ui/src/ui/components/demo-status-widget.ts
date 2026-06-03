import { LitElement, html } from "lit";

const DEMO_STATUS_STATES = [
  {
    id: "online",
    label: "Online",
    detail: "Gateway reachable",
  },
  {
    id: "syncing",
    label: "Syncing",
    detail: "Static demo refresh",
  },
  {
    id: "paused",
    label: "Paused",
    detail: "Automation idle",
  },
] as const;

export class OpenClawDemoStatusWidget extends LitElement {
  override connectedCallback() {
    super.connectedCallback();
    this.setAttribute("aria-label", "System Status");
  }

  override createRenderRoot() {
    return this;
  }

  override render() {
    return html`
      <section class="demo-status-widget">
        <div class="demo-status-widget__title">System Status</div>
        <div class="demo-status-widget__states">
          ${DEMO_STATUS_STATES.map(
            (state) => html`
              <div
                class="demo-status-widget__state demo-status-widget__state--${state.id}"
                title=${`${state.label}: ${state.detail}`}
              >
                <span class="demo-status-widget__dot" aria-hidden="true"></span>
                <span class="demo-status-widget__label">${state.label}</span>
                <span class="demo-status-widget__detail">${state.detail}</span>
              </div>
            `,
          )}
        </div>
      </section>
    `;
  }
}

if (!customElements.get("openclaw-demo-status-widget")) {
  customElements.define("openclaw-demo-status-widget", OpenClawDemoStatusWidget);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-demo-status-widget": OpenClawDemoStatusWidget;
  }
}
