import type { GatewayBrowserClient } from "../../../api/gateway.ts";
import type { ApplicationContext } from "../../../app/context.ts";
import { ConfigMutationRefusedError } from "../../../lib/config/config-mutation-runner.ts";
import { formatUiExternalText } from "../../../lib/format-error.ts";
import { runPluginConfigMutation, type PluginInstallRequest } from "../../../lib/plugins/index.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { showToast } from "../../../lib/toast.ts";
import { readPluginInstallPolicyWarning } from "../../plugins/install-policy-warning.ts";
import { pluginInstallOperations } from "../../plugins/install-progress.ts";

/**
 * Installs a recommended plugin without leaving the chat. The shared install
 * owner presents progress and failures on every card and on the plugin page;
 * warnings from a successful install are announced.
 *
 * Resolves true when only the plugin page can continue: it reviews
 * install-policy findings and explains a refusal that sent no request.
 */
export async function installPluginFromChatCard(
  context: Pick<ApplicationContext, "gateway" | "runtimeConfig">,
  client: GatewayBrowserClient,
  request: PluginInstallRequest,
  catalogId: string,
): Promise<boolean> {
  try {
    const { value, refreshError } = await runPluginConfigMutation(
      context.runtimeConfig,
      client,
      (admitted) =>
        pluginInstallOperations(context.gateway).run(admitted, request, "install:" + catalogId),
    );
    // The plugin page lists these beside its row; a card has no row to hold them.
    const warnings = [
      ...(value.warnings ?? []).map((warning) => formatUiExternalText(warning)),
      ...(refreshError ? [t("pluginsPage.configRefreshFailed", { error: refreshError })] : []),
    ];
    if (warnings.length) {
      showToast({ severity: "warning", message: warnings.join("\n"), durationMs: 12_000 });
    }
    return false;
  } catch (error) {
    return (
      readPluginInstallPolicyWarning(error) !== undefined ||
      error instanceof ConfigMutationRefusedError
    );
  }
}
