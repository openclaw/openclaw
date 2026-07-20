import { html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { t } from "../i18n/index.ts";
import { OpenClawLightDomContentsElement } from "../lit/openclaw-element.ts";
import { getSafeLocalStorage } from "../local-storage.ts";
import { icons } from "./icons.ts";

export const STALE_BUNDLE_DISMISS_KEY = "openclaw:control-ui:stale-bundle-dismissed:v1";

type DismissedStaleBundle = {
  gatewayVersion: string;
  dismissedAtMs: number;
};

function isDismissed(gatewayVersion: string): boolean {
  try {
    const raw = getSafeLocalStorage()?.getItem(STALE_BUNDLE_DISMISS_KEY);
    if (!raw) {
      return false;
    }
    const dismissed = JSON.parse(raw) as Partial<DismissedStaleBundle>;
    return dismissed.gatewayVersion === gatewayVersion;
  } catch {
    return false;
  }
}

function dismiss(gatewayVersion: string): void {
  try {
    getSafeLocalStorage()?.setItem(
      STALE_BUNDLE_DISMISS_KEY,
      JSON.stringify({ gatewayVersion, dismissedAtMs: Date.now() } satisfies DismissedStaleBundle),
    );
  } catch {
    // Dismissal persistence is best effort; this card still hides for the current mount.
  }
}

class SidebarStaleBundleCard extends OpenClawLightDomContentsElement {
  @property({ attribute: false }) gatewayVersion: string | null = null;
  @property({ attribute: false }) onRefresh: () => void = () => undefined;
  @state() private dismissedGatewayVersion: string | null = null;

  override render() {
    const gatewayVersion = this.gatewayVersion;
    if (
      !gatewayVersion ||
      this.dismissedGatewayVersion === gatewayVersion ||
      isDismissed(gatewayVersion)
    ) {
      return nothing;
    }
    return html`
      <div class="sidebar-stale-bundle" role="status" aria-live="polite">
        <span class="sidebar-stale-bundle__text">${t("chat.sidebar.staleBundle")}</span>
        <button class="sidebar-stale-bundle__refresh" type="button" @click=${this.onRefresh}>
          ${t("common.refresh")}
        </button>
        <button
          class="sidebar-stale-bundle__dismiss"
          type="button"
          aria-label=${t("common.dismiss")}
          @click=${() => {
            this.dismissedGatewayVersion = gatewayVersion;
            dismiss(gatewayVersion);
          }}
        >
          ${icons.x}
        </button>
      </div>
    `;
  }
}

if (!customElements.get("openclaw-sidebar-stale-bundle-card")) {
  customElements.define("openclaw-sidebar-stale-bundle-card", SidebarStaleBundleCard);
}
