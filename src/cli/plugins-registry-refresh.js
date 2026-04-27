import { formatErrorMessage } from "../infra/errors.js";
import { refreshPluginRegistry } from "../plugins/plugin-registry.js";
export async function refreshPluginRegistryAfterConfigMutation(params) {
    try {
        await refreshPluginRegistry({
            config: params.config,
            reason: params.reason,
            ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
            ...(params.env ? { env: params.env } : {}),
        });
    }
    catch (error) {
        params.logger?.warn?.(`Plugin registry refresh failed: ${formatErrorMessage(error)}`);
    }
}
