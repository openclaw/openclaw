import { html, nothing, type ReactiveControllerHost, type ReactiveController } from "lit";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { t } from "../../i18n/index.ts";
import { registerModelSetupEnglish } from "../../i18n/locales/en-model-setup.ts";

registerModelSetupEnglish();

type DiscoveryOwner = {
  client: GatewayBrowserClient | null;
  agentId: string | null;
};
type DiscoveryOptions = {
  canOpen: () => boolean;
  getOwner: () => DiscoveryOwner;
  onClose: () => void;
  onError: (error: unknown) => void;
};

export class ModelProviderDiscoveryController implements ReactiveController {
  private state: "closed" | "loading" | "ready" = "closed";
  private owner: DiscoveryOwner | null = null;

  constructor(
    private readonly host: ReactiveControllerHost,
    private readonly options: DiscoveryOptions,
  ) {
    host.addController(this);
  }

  get busy(): boolean {
    return this.state !== "closed";
  }

  reset(): void {
    this.state = "closed";
    this.owner = null;
    this.host.requestUpdate();
  }

  hostUpdated(): void {
    const owner = this.owner;
    if (!owner) {
      return;
    }
    const agentId = this.options.getOwner().agentId;
    // Reconnect can temporarily clear the roster selection. The mounted setup
    // owns wizard recovery and authorization loss; only a new selection replaces it.
    if (agentId !== null && agentId !== owner.agentId) {
      this.reset();
    }
  }

  cancelLoading(): void {
    if (this.state === "loading") {
      this.reset();
    }
  }

  hostDisconnected(): void {
    this.reset();
  }

  async open(): Promise<void> {
    if (!this.options.canOpen() || this.busy) {
      return;
    }
    const owner = this.options.getOwner();
    if (!owner.client) {
      return;
    }
    this.owner = owner;
    this.state = "loading";
    this.host.requestUpdate();
    try {
      await import("../model-setup/model-setup-page.ts");
      if (this.state === "loading") {
        this.state = "ready";
        this.host.requestUpdate();
      }
    } catch (error) {
      if (this.state === "loading") {
        this.reset();
        this.options.onError(error);
      }
    }
  }

  render(data: { agentLabel: string; credentialChoices: readonly string[] }) {
    if (this.state === "closed") {
      return nothing;
    }
    const close = (refresh = false) => {
      this.reset();
      if (refresh) {
        this.options.onClose();
      }
    };
    if (this.state === "loading") {
      return html`<openclaw-modal-dialog
        label=${t("modelSetup.discovery.title")}
        @modal-cancel=${() => close()}
      >
        <div class="model-setup-wizard">
          <div class="model-setup-wizard__body" role="status">${t("common.loading")}</div>
          <div class="model-setup-wizard__footer">
            <button class="btn" @click=${() => close()}>${t("common.cancel")}</button>
          </div>
        </div>
      </openclaw-modal-dialog>`;
    }
    return html`<openclaw-model-setup-page
      .routeData=${{ firstRun: false }}
      .embedded=${true}
      .credentialChoices=${data.credentialChoices}
      .agentLabel=${data.agentLabel}
      .onClose=${() => close(true)}
    ></openclaw-model-setup-page>`;
  }
}
