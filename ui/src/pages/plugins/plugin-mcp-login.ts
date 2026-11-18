import { createSignal, onCleanup } from "solid-js";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import { createWizardLogin } from "../../components/wizard-login-controller.tsx";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import type { GatewayConnectionScope } from "../../lib/gateway-connection-lifecycle.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import type { GatewayPageBinding } from "../../lib/gateway-page-binding.ts";
import type { ModelSetupWizardCompletion } from "../model-setup/wizard-runner.ts";
import { pluginRowKey, type PluginRowMessage } from "./plugin-row-message.tsx";
import type { PluginsPageDetail } from "./plugins-page-model.ts";

/** Binds operator sign-in and sign-out to the selected plugin and live Gateway. */
export function createPluginMcpLogin(
  gateway: Pick<GatewayPageBinding, "client" | "snapshot" | "capture" | "isCurrent">,
  options: {
    getDetail: () => Pick<PluginsPageDetail, "pluginId" | "inspection"> | null;
    getName: (pluginId: string) => string | undefined;
    refresh: (pluginId: string) => Promise<void>;
    setMessage: (rowKey: string, message: PluginRowMessage | null) => void;
  },
) {
  const canCall = (method: "mcp.authLogin" | "mcp.authLogout") =>
    canCallGatewayMethod(gateway.snapshot, method, "operator.admin");
  let currentSelection: { pluginId: string; scope: GatewayConnectionScope } | null = null;
  const [signingOut, setSigningOut] = createSignal(false, { ownedWrite: true });
  const [outcome, setOutcome] = createSignal<"cancelled" | "expired" | "failed">();
  const dialog = createWizardLogin({
    getClient: () => gateway.client,
    getAgentId: () => null,
    requestFailedMessage: () => t("pluginsPage.auth.requestFailed"),
    sessionExpiredMessage: () => t("pluginsPage.auth.sessionExpired"),
    onCancelled: () => setOutcome("cancelled"),
    onSessionMissing: () => setOutcome("expired"),
    onClose: () => {
      if (dialog.runner.state.phase === "error" && outcome() !== "expired") {
        setOutcome("failed");
      }
      const pluginId = currentSelection?.pluginId;
      reset(true);
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
    return signingOut() || dialog.state().phase !== "idle";
  }

  function hasAccount(
    detail: Pick<PluginsPageDetail, "pluginId" | "inspection">,
    serverName: string,
    authorized: boolean,
  ) {
    return Boolean(
      detail.inspection?.mcpAuth?.some(
        (entry) => entry.serverName === serverName && (entry.state === "authorized") === authorized,
      ),
    );
  }

  function reset(preserveOutcome = false) {
    if (!preserveOutcome) {
      setOutcome(undefined);
    }
    currentSelection = null;
    dialog.reset();
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
  async function start(serverName: string): Promise<void> {
    const scope = gateway.capture();
    const detail = options.getDetail();
    if (
      !scope ||
      !detail ||
      !canCall("mcp.authLogin") ||
      busy() ||
      !hasAccount(detail, serverName, false)
    ) {
      return;
    }
    setOutcome(undefined);
    const selection = { pluginId: detail.pluginId, scope };
    currentSelection = selection;
    dialog.runner.prepareSignIn("oauth", options.getName(detail.pluginId) ?? serverName);
    const completion = await dialog.runner.startMcpLogin(serverName);
    if (selection === currentSelection) {
      await complete(completion);
    }
  }
  return {
    dialog,
    outcome,
    async retry(serverName: string): Promise<void> {
      if (dialog.runner.state.phase === "starting" || dialog.runner.state.phase === "step") {
        return;
      }
      reset();
      await start(serverName);
    },
    get busy() {
      return busy();
    },
    select(pluginId: string | null) {
      if (currentSelection && currentSelection.pluginId !== pluginId) {
        reset();
      }
    },
    reset,
    start,
    async signOut(serverName: string): Promise<void> {
      const scope = gateway.capture();
      const detail = options.getDetail();
      if (
        !scope ||
        !detail ||
        !canCall("mcp.authLogout") ||
        busy() ||
        !hasAccount(detail, serverName, true)
      ) {
        return;
      }
      const { pluginId } = detail;
      const name = options.getName(pluginId) ?? serverName;
      setSigningOut(true);
      let confirmed = false;
      try {
        confirmed = await showConfirmDialog({
          title: t("pluginsPage.auth.signOutConfirmTitle", { name }),
          message: t("pluginsPage.auth.signOutConfirmMessage", { name }),
          confirmLabel: t("pluginsPage.auth.signOut"),
          danger: true,
        });
        if (!confirmed || !gateway.isCurrent(scope)) {
          return;
        }
        options.setMessage(pluginRowKey(pluginId), null);
        await scope.client.request("mcp.authLogout", { serverName });
      } catch (error) {
        if (gateway.isCurrent(scope)) {
          // A confirmation that failed to open has no useful detail; the account is unchanged.
          options.setMessage(pluginRowKey(pluginId), {
            kind: "error",
            text: confirmed ? formatUiError(error) : t("pluginsPage.auth.signOutUnavailable"),
          });
        }
      } finally {
        setSigningOut(false);
      }
      // The credential owner decides the outcome; re-inspect instead of guessing it.
      if (confirmed && gateway.isCurrent(scope) && options.getDetail()?.pluginId === pluginId) {
        await options.refresh(pluginId);
      }
    },
  };
}
