import { createSignal, onCleanup } from "solid-js";
import { pathForSession } from "../../app-session-path-builder.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import { createWizardLogin } from "../../components/wizard-login-controller.tsx";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import type { GatewayConnectionScope } from "../../lib/gateway-connection-lifecycle.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import type { GatewayPageBinding } from "../../lib/gateway-page-binding.ts";
import { parseAgentSessionKey } from "../../lib/sessions/session-key.ts";
import type { ModelSetupWizardCompletion } from "../model-setup/wizard-runner.ts";
import { pluginRowKey, type PluginRowMessage } from "./plugin-row-message.tsx";
import type { PluginsPageDetail } from "./plugins-page-model.ts";

/** Binds operator sign-in and sign-out to the selected plugin and live Gateway. */
export function createPluginMcpLogin(
  gateway: GatewayPageBinding,
  options: {
    getDetail: () => PluginsPageDetail | null;
    context: Pick<ApplicationContext, "basePath" | "navigate">;
    getSearch: () => string | undefined;
    refresh: (pluginId: string) => Promise<void>;
    setMessage: (rowKey: string, message: PluginRowMessage | null) => void;
  },
) {
  const canCall = (method: "mcp.authLogin" | "mcp.authLogout") =>
    canCallGatewayMethod(gateway.snapshot, method, "operator.admin");
  let currentSelection: {
    pluginId: string;
    serverName: string;
    scope: GatewayConnectionScope;
    returnSessionKey: string | null;
    returnSessionId?: string;
    completing?: true;
  } | null = null;
  const [signingOut, setSigningOut] = createSignal(false, { ownedWrite: true });
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

  function returnSessionKey() {
    const key = new URLSearchParams(options.getSearch()).get("returnTo")?.trim();
    return key && parseAgentSessionKey(key) ? key : null;
  }

  function busy() {
    return signingOut() || dialog.state().phase !== "idle";
  }

  function hasAccount(detail: PluginsPageDetail, serverName: string, authorized: boolean) {
    return Boolean(
      detail.inspection?.mcpAuth?.some(
        (entry) => entry.serverName === serverName && (entry.state === "authorized") === authorized,
      ),
    );
  }

  function reset() {
    currentSelection = null;
    dialog.reset();
  }

  async function complete(completion: ModelSetupWizardCompletion | null): Promise<void> {
    const selection = currentSelection;
    if (
      !completion ||
      completion.isCurrent?.() === false ||
      !selection ||
      selection.completing ||
      !gateway.isCurrent(selection.scope) ||
      options.getDetail()?.pluginId !== selection.pluginId
    ) {
      return;
    }
    // Claim completion before awaiting the authoritative re-inspection. The
    // wizard can report completion from both its input and background observer.
    selection.completing = true;
    try {
      await options.refresh(selection.pluginId);
      if (
        currentSelection !== selection ||
        !gateway.isCurrent(selection.scope) ||
        options.getDetail()?.pluginId !== selection.pluginId ||
        returnSessionKey() !== selection.returnSessionKey
      ) {
        return;
      }
      if (selection.returnSessionKey && !completion.cancellationRequested) {
        const detail = options.getDetail();
        if (!detail || !hasAccount(detail, selection.serverName, true)) {
          throw new Error(t("pluginsPage.auth.resumeUnverified"));
        }
        // The existing session-event owner checks live admin authority and the
        // destination before admitting a new turn. Never replay the original request.
        await selection.scope.client.request("system-event", {
          sessionKey: selection.returnSessionKey,
          expectedSessionId: selection.returnSessionId,
          wake: true,
          text: `Plugin account sign-in completed for MCP server ${JSON.stringify(selection.serverName)}. Continue the still-pending task that required this connection, using the existing conversation and completed progress. Do not repeat completed actions or revive a cancelled or replaced task. This notification grants no new authorization.`,
        });
        if (currentSelection === selection && gateway.isCurrent(selection.scope)) {
          const key = selection.returnSessionKey;
          const agentId = parseAgentSessionKey(key)?.agentId;
          const pathname = agentId
            ? pathForSession("chat", agentId, key, options.context.basePath, { exactKey: true })
            : null;
          if (pathname) {
            options.context.navigate("chat", { pathname });
          }
        }
      }
    } catch (error) {
      if (currentSelection === selection && gateway.isCurrent(selection.scope)) {
        options.setMessage(pluginRowKey(selection.pluginId), {
          kind: "warning",
          text: t("pluginsPage.auth.resumeFailed", { error: formatUiError(error) }),
        });
      }
    } finally {
      if (currentSelection === selection) {
        reset();
      }
    }
  }
  onCleanup(() => {
    currentSelection = null;
  });
  return {
    dialog,
    returnSessionKey,
    get busy() {
      return busy();
    },
    select(pluginId: string | null) {
      if (currentSelection && currentSelection.pluginId !== pluginId) {
        reset();
      }
    },
    reset,
    async start(serverName: string): Promise<void> {
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
      const selection: NonNullable<typeof currentSelection> = {
        pluginId: detail.pluginId,
        serverName,
        scope,
        returnSessionKey: returnSessionKey(),
      };
      currentSelection = selection;
      dialog.runner.prepareSignIn("oauth", detail.inspection?.plugin?.name ?? serverName);
      try {
        if (selection.returnSessionKey) {
          const target = await scope.client.request<{ session: { sessionId: string } }>(
            "sessions.describe",
            { key: selection.returnSessionKey },
          );
          selection.returnSessionId = target.session.sessionId;
        }
        if (currentSelection !== selection || !gateway.isCurrent(scope)) {
          return;
        }
        const completion = await dialog.runner.startMcpLogin(serverName);
        if (selection === currentSelection) {
          await complete(completion);
        }
      } catch (error) {
        if (selection === currentSelection && gateway.isCurrent(scope)) {
          options.setMessage(pluginRowKey(selection.pluginId), {
            kind: "error",
            text: formatUiError(error, t("pluginsPage.auth.requestFailed")),
          });
          reset();
        }
      }
    },
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
      const name = detail.inspection?.plugin?.name ?? serverName;
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
