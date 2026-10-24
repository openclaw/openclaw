import { onCleanup } from "solid-js";
import { createWizardLogin } from "../../components/wizard-login-controller.tsx";
import { t } from "../../i18n/index.ts";
import type { GatewayConnectionScope } from "../../lib/gateway-connection-lifecycle.ts";
import type { GatewayPageBinding } from "../../lib/gateway-page-binding.ts";
import type { ModelSetupWizardCompletion } from "../model-setup/wizard-runner.ts";
import type { PluginsPageDetail } from "./plugins-page-model.ts";

/** Binds the shared OAuth dialog to the selected plugin and live Gateway. */
export function createPluginMcpLogin(
  gateway: GatewayPageBinding,
  options: {
    getDetail: () => PluginsPageDetail | null;
    getName: (pluginId: string) => string | undefined;
    canSignIn: () => boolean;
    refresh: (pluginId: string) => Promise<void>;
  },
) {
  let currentSelection: { pluginId: string; scope: GatewayConnectionScope } | null = null;
  const dialog = createWizardLogin({
    getClient: () => gateway.client,
    getAgentId: () => null,
    requestFailedMessage: () => t("pluginsPage.auth.requestFailed"),
    sessionExpiredMessage: () => t("pluginsPage.auth.sessionExpired"),
    onClose: () => {
      const pluginId = currentSelection?.pluginId;
      reset();
      if (pluginId && options.getDetail()?.pluginId === pluginId) {
        void options.refresh(pluginId);
      }
    },
    onAnswer: (value, includeValue) => {
      const selection = currentSelection;
      void dialog.runner.answer(value, includeValue).then((completion) => {
        if (selection === currentSelection) {
          void complete(completion);
        }
      });
    },
    onBackgroundCompletion: (completion) => complete(completion),
  });

  function busy() {
    return dialog.state().phase !== "idle";
  }

  function select(pluginId: string | null) {
    if (currentSelection && currentSelection.pluginId !== pluginId) {
      reset();
    }
  }

  function reset() {
    currentSelection = null;
    dialog.reset();
  }

  async function start(serverName: string): Promise<void> {
    const scope = gateway.capture();
    const detail = options.getDetail();
    if (
      !scope ||
      !detail ||
      !options.canSignIn() ||
      busy() ||
      !detail.inspection?.mcpAuth?.some(
        (entry) => entry.serverName === serverName && entry.state !== "authorized",
      )
    ) {
      return;
    }
    const selection = { pluginId: detail.pluginId, scope };
    currentSelection = selection;
    dialog.runner.prepareSignIn("oauth", options.getName(detail.pluginId) ?? serverName);
    const completion = await dialog.runner.startMcpLogin(serverName);
    if (selection === currentSelection) {
      await complete(completion);
    }
  }

  async function complete(completion: ModelSetupWizardCompletion | null): Promise<void> {
    const selection = currentSelection;
    if (
      !completion ||
      completion.isCurrent?.() === false ||
      !selection ||
      !gateway.isCurrent(selection.scope) ||
      options.getDetail()?.pluginId !== selection.pluginId
    ) {
      return;
    }
    // Tokens are saved by the OAuth owner. Re-inspect this same plugin instead
    // of optimistically marking a connection authenticated in the renderer.
    reset();
    await options.refresh(selection.pluginId);
  }
  onCleanup(() => {
    currentSelection = null;
  });
  return {
    dialog,
    get busy() {
      return busy();
    },
    select,
    reset,
    start,
  };
}
