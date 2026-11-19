import type { GatewayBrowserClient } from "../../../api/gateway.ts";
import type { ApplicationContext } from "../../../app/context.ts";
import { ConfigMutationRefusedError } from "../../../lib/config/config-mutation-runner.ts";
import { runPluginConfigMutation, type PluginInstallRequest } from "../../../lib/plugins/index.ts";
import { readPluginInstallPolicyWarning } from "../../plugins/install-policy-warning.ts";
import { pluginInstallOperations } from "../../plugins/install-progress.ts";

/**
 * Installs a recommended plugin without leaving the chat. The shared install
 * owner presents progress and failures on every card and on the plugin page.
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
    await runPluginConfigMutation(context.runtimeConfig, client, (admitted) =>
      pluginInstallOperations(context.gateway).run(admitted, request, "install:" + catalogId),
    );
    return false;
  } catch (error) {
    return (
      readPluginInstallPolicyWarning(error) !== undefined ||
      error instanceof ConfigMutationRefusedError
    );
  }
}
