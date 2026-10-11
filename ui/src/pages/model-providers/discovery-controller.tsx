import { createMemo, Show } from "solid-js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { registerModelSetupEnglish } from "../../i18n/locales/en-model-setup.ts";
import { t } from "../../lib/reactive/i18n.ts";
import type { ControllerHost } from "./page-controller.ts";

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

export class ModelProviderDiscoveryController {
  private state: "closed" | "loading" | "ready" = "closed";
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
      await import("../model-setup/model-setup-page.tsx");
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
            const close = (refresh = false) => {
              this.reset();
              if (refresh) {
                this.options.onClose();
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
