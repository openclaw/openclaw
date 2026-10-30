import { createSignal, Errored, lazy, Loading, onSettled, Show } from "solid-js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { registerModelSetupEnglish } from "../../i18n/locales/en-model-setup.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";

registerEnglishCatalog(registerModelSetupEnglish);

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

export function createModelProviderDiscovery(options: DiscoveryOptions) {
  const [opened, setOpened] = createSignal<DiscoveryOwner | null>(null);
  let owner: DiscoveryOwner | null = null;
  // Connection replacement cancels only the import; mounted setup owns recovery.
  let loading = false;

  function reset() {
    owner = null;
    loading = false;
    setOpened(null);
  }

  // Selection receipts retire a lazy setup request owned by another agent.
  function synchronize() {
    const { agentId } = options.getOwner();
    // Reconnect can temporarily clear selection; the mounted setup owns recovery.
    if (owner && agentId !== null && agentId !== owner.agentId) {
      reset();
    }
  }
  onSettled(() => () => {
    owner = null;
    loading = false;
  });

  function cancelLoading() {
    if (loading) {
      reset();
    }
  }

  function open() {
    if (!options.canOpen() || owner) {
      return;
    }
    const nextOwner = options.getOwner();
    if (!nextOwner.client) {
      return;
    }
    owner = nextOwner;
    loading = true;
    setOpened(nextOwner);
  }

  function render(getData: () => { agentLabel: string; credentialChoices: readonly string[] }) {
    const close = (refresh = false) => {
      reset();
      if (refresh) {
        options.onClose();
      }
    };
    return (
      <Show when={opened()} keyed>
        {(target) => {
          // Each opening can retry a failed import without retaining the retired view.
          const ModelSetup = lazy(
            async () => {
              const module = await import("../model-setup/model-setup-page.tsx");
              if (owner === target) {
                loading = false;
              }
              return module;
            },
            { export: "ModelSetupPage" },
          );
          return (
            <Errored
              fallback={(error) => {
                onSettled(() => {
                  if (owner === target) {
                    reset();
                    options.onError(error());
                  }
                });
                return undefined;
              }}
            >
              <Loading
                fallback={
                  <openclaw-modal-dialog
                    label={t("modelSetup.discovery.title")}
                    onModal-cancel={() => close()}
                  >
                    <div class="model-setup-wizard">
                      <div class="model-setup-wizard__body" role="status">
                        {t("common.loading")}
                      </div>
                      <openclaw-modal-actions class="model-setup-wizard__footer">
                        <button class="btn" onClick={() => close()}>
                          {t("common.cancel")}
                        </button>
                      </openclaw-modal-actions>
                    </div>
                  </openclaw-modal-dialog>
                }
              >
                <ModelSetup
                  routeData={{ firstRun: false }}
                  embedded
                  credentialChoices={getData().credentialChoices}
                  agentLabel={getData().agentLabel}
                  onClose={() => close(true)}
                />
              </Loading>
            </Errored>
          );
        }}
      </Show>
    );
  }

  return {
    get busy() {
      return opened() !== null;
    },
    cancelLoading,
    synchronize,
    open,
    render,
  };
}
