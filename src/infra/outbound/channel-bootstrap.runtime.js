import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { applyPluginAutoEnable } from "../../config/plugin-auto-enable.js";
import { resolveRuntimePluginRegistry } from "../../plugins/loader.js";
import { getActivePluginChannelRegistry, getActivePluginChannelRegistryVersion, } from "../../plugins/runtime.js";
const bootstrapAttempts = new Set();
export function resetOutboundChannelBootstrapStateForTests() {
    bootstrapAttempts.clear();
}
export function bootstrapOutboundChannelPlugin(params) {
    const cfg = params.cfg;
    if (!cfg) {
        return;
    }
    const activeChannelRegistry = getActivePluginChannelRegistry();
    const activeHasRequestedChannel = activeChannelRegistry?.channels?.some((entry) => entry?.plugin?.id === params.channel);
    if (activeHasRequestedChannel) {
        return;
    }
    const attemptKey = `${getActivePluginChannelRegistryVersion()}:${params.channel}`;
    if (bootstrapAttempts.has(attemptKey)) {
        return;
    }
    bootstrapAttempts.add(attemptKey);
    const autoEnabled = applyPluginAutoEnable({ config: cfg });
    const defaultAgentId = resolveDefaultAgentId(autoEnabled.config);
    const workspaceDir = resolveAgentWorkspaceDir(autoEnabled.config, defaultAgentId);
    try {
        resolveRuntimePluginRegistry({
            config: autoEnabled.config,
            activationSourceConfig: cfg,
            autoEnabledReasons: autoEnabled.autoEnabledReasons,
            workspaceDir,
            runtimeOptions: {
                allowGatewaySubagentBinding: true,
            },
        });
    }
    catch {
        bootstrapAttempts.delete(attemptKey);
    }
}
