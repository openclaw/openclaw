// Control UI component renders the offline/reconnecting banner shown while
// the gateway connection is interrupted but the dashboard stays mounted.
import { LitElement, html, nothing } from "lit";
import { property } from "lit/decorators.js";
import { t } from "../i18n/index.ts";
import { icons } from "./icons.ts";
import { redactLoginFailureError } from "./login-gate.ts";

export type ConnectionBannerProps = {
  lastError: string | null;
  onRetry: () => void;
};

function renderConnectionBanner(props: ConnectionBannerProps) {
  const detail = props.lastError ? redactLoginFailureError(props.lastError) : null;
  return html`
    <div class="connection-banner callout warn" role="status" aria-live="polite">
      <span class="connection-banner__spinner" aria-hidden="true">${icons.loader}</span>
      <span class="connection-banner__text">
        <strong>${t("connection.lostTitle")}</strong>
        ${t("connection.reconnecting")}
        <span class="connection-banner__hint" title=${detail ?? ""}
          >${t("connection.offlineHint")}</span
        >
      </span>
      <button class="btn btn--sm connection-banner__retry" type="button" @click=${props.onRetry}>
        ${t("connection.retryNow")}
      </button>
    </div>
  `;
}

export class ConnectionBanner extends LitElement {
  override createRenderRoot() {
    return this;
  }

  @property({ attribute: false }) props?: ConnectionBannerProps;

  override connectedCallback() {
    super.connectedCallback();
    this.style.display = "contents";
  }

  override render() {
    return this.props ? renderConnectionBanner(this.props) : nothing;
  }
}

if (!customElements.get("openclaw-connection-banner")) {
  customElements.define("openclaw-connection-banner", ConnectionBanner);
}
