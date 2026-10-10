import { createMemo, Show } from "solid-js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { registerModelSetupEnglish } from "../../i18n/locales/en-model-setup.ts";
import { t } from "../../lib/reactive/i18n.ts";
import type { ControllerHost } from "./page-controller.ts";

registerModelSetupEnglish();

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
  onError: (error: unknown) => void;
};

export class ModelProviderDiscoveryController {
  private state: "closed" | "loading" | "ready" = "closed";
  private generation = 0;
  private owner: DiscoveryOwner | null = null;

  constructor(
    private readonly host: ControllerHost,
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
      await import("../model-setup/model-setup-page.tsx");
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

  render(
    getData: () => { agentLabel: string; credentialChoices: readonly string[] },
    revision: () => unknown,
  ) {
    const Discovery = () => {
      const state = createMemo(() => {
        revision();
        return this.state === "closed" ? undefined : this.state;
      });
      const data = createMemo(() => {
        revision();
        return getData();
      });
      return (
        <Show when={state()} keyed>
          {(phase) => {
            const generation = this.generation;
            const close = (refresh = false) => {
              if (generation === this.generation) {
                this.reset();
                if (refresh) {
                  this.options.onClose();
                }
              }
            };
            return phase === "loading" ? (
              <openclaw-modal-dialog
                label={t("modelSetup.discovery.title")}
                onModal-cancel={() => close()}
              >
                <div class="model-setup-wizard">
                  <div class="model-setup-wizard__body" role="status">
                    {t("common.loading")}
                  </div>
                  <div class="model-setup-wizard__footer">
                    <button class="btn" onClick={() => close()}>
                      {t("common.cancel")}
                    </button>
                  </div>
                </div>
              </openclaw-modal-dialog>
            ) : (
              <openclaw-model-setup-page
                prop:routeData={{ firstRun: false }}
                prop:embedded={true}
                prop:credentialChoices={data().credentialChoices}
                prop:agentLabel={data().agentLabel}
                prop:onClose={() => close(true)}
              />
            );
          }}
        </Show>
      );
    };
    return <Discovery />;
  }
}
