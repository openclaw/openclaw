import { createComponent, createEffect, createSignal, onCleanup, Show } from "solid-js";
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
  const [phase, setPhase] = createSignal<
    "closed" | "loading" | typeof import("../model-setup/model-setup-page.tsx").ModelSetupPage
  >("closed");
  let owner: DiscoveryOwner | null = null;
  let loading = false;

  function reset() {
    owner = null;
    loading = false;
    setPhase("closed");
  }

  // Retire the lazy setup request when its selected-agent owner changes.
  createEffect(
    () => options.getOwner().agentId,
    (agentId) => {
      // Reconnect can temporarily clear selection; the mounted setup owns recovery.
      if (owner && agentId !== null && agentId !== owner.agentId) {
        reset();
      }
    },
  );
  onCleanup(() => {
    owner = null;
    loading = false;
  });

  function cancelLoading() {
    if (loading) {
      reset();
    }
  }

  async function open() {
    if (!options.canOpen() || owner) {
      return;
    }
    const nextOwner = options.getOwner();
    if (!nextOwner.client) {
      return;
    }
    owner = nextOwner;
    loading = true;
    setPhase("loading");
    try {
      const { ModelSetupPage } = await import("../model-setup/model-setup-page.tsx");
      if (owner === nextOwner) {
        loading = false;
        setPhase(() => ModelSetupPage);
      }
    } catch (error) {
      if (owner === nextOwner) {
        reset();
        options.onError(error);
      }
    }
  }

  function render(getData: () => { agentLabel: string; credentialChoices: readonly string[] }) {
    const content = () => {
      const current = phase();
      return current === "closed" ? undefined : current;
    };
    const close = (refresh = false) => {
      reset();
      if (refresh) {
        options.onClose();
      }
    };
    return (
      <Show when={content()} keyed>
        {(current) =>
          current === "loading" ? (
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
          ) : (
            createComponent(current, {
              routeData: { firstRun: false },
              embedded: true,
              get credentialChoices() {
                return getData().credentialChoices;
              },
              get agentLabel() {
                return getData().agentLabel;
              },
              onClose: () => close(true),
            })
          )
        }
      </Show>
    );
  }

  return {
    get busy() {
      return phase() !== "closed";
    },
    cancelLoading,
    open,
    render,
  };
}
