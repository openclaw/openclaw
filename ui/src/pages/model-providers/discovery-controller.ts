import { html, nothing, type ReactiveControllerHost, type ReactiveController } from "lit";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { t } from "../../i18n/index.ts";

function renderModelProviderDiscovery(props: {
  state: "closed" | "loading" | "ready";
  agentLabel: string;
  credentialChoices: readonly string[];
  onCancel: () => void;
  onClose: () => void;
  onConnectChoice: (authChoice?: string) => void;
}) {
  if (props.state === "closed") {
    return nothing;
  }
  if (props.state === "loading") {
    return html`<openclaw-modal-dialog
      label=${t("modelSetup.discovery.title")}
      @modal-cancel=${props.onCancel}
    >
      <div class="model-setup-wizard">
        <div class="model-setup-wizard__body" role="status">${t("common.loading")}</div>
        <div class="model-setup-wizard__footer">
          <button class="btn" @click=${props.onCancel}>${t("common.cancel")}</button>
        </div>
      </div>
    </openclaw-modal-dialog>`;
  }
  return html`<openclaw-model-setup-page
    .routeData=${{ firstRun: false }}
    .embedded=${true}
    .onConnectChoice=${props.onConnectChoice}
    .credentialChoices=${props.credentialChoices}
    .agentLabel=${props.agentLabel}
    .onClose=${props.onClose}
  ></openclaw-model-setup-page>`;
}

type DiscoveryOwner = {
  client: GatewayBrowserClient | null;
  epoch: number;
  agentEpoch: number;
  agentId: string | null;
  selectionIntentRevision: number;
  selectionPending: boolean;
};
type DiscoveryOptions = {
  canOpen: () => boolean;
  getOwner: () => DiscoveryOwner;
  isCurrent: (owner: DiscoveryOwner) => boolean;
  onClose: () => void;
  onConnectChoice: (authChoice?: string) => void;
  onError: (error: unknown) => void;
};

export class ModelProviderDiscoveryController implements ReactiveController {
  private state: "closed" | "loading" | "ready" = "closed";
  private generation = 0;
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
    this.generation += 1;
    this.state = "closed";
    this.owner = null;
    this.host.requestUpdate();
  }

  hostUpdated(): void {
    const owner = this.owner;
    if (!owner) {
      return;
    }
    const current = this.options.getOwner();
    if (
      (this.state === "loading" && !this.options.isCurrent(owner)) ||
      current.selectionIntentRevision !== owner.selectionIntentRevision ||
      (!current.selectionPending && current.agentId !== owner.agentId)
    ) {
      this.reset();
    }
  }

  cancelLoading(): void {
    // Once mounted, ModelSetupPage owns reconnect recovery and authority loss.
    // Only an unfinished import belongs to the parent transport epoch.
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
    const generation = this.generation;
    const isCurrent = () =>
      generation === this.generation && this.state === "loading" && this.options.isCurrent(owner);
    this.owner = owner;
    this.state = "loading";
    this.host.requestUpdate();
    try {
      await import("../model-setup/model-setup-page.ts");
      if (isCurrent()) {
        this.state = "ready";
        this.host.requestUpdate();
      }
    } catch (error) {
      if (isCurrent()) {
        this.reset();
        this.options.onError(error);
      }
    }
  }

  render(data: { agentLabel: string; credentialChoices: readonly string[] }) {
    const generation = this.generation;
    return renderModelProviderDiscovery({
      ...data,
      state: this.state,
      onCancel: () => {
        if (generation === this.generation) {
          this.reset();
        }
      },
      onClose: () => {
        if (generation === this.generation) {
          this.reset();
          this.options.onClose();
        }
      },
      onConnectChoice: (provider) => {
        if (generation === this.generation) {
          this.reset();
          this.options.onConnectChoice(provider);
        }
      },
    });
  }
}
