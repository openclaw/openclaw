import { collectChannelConfigAssignments } from "./runtime-config-collectors-channels.js";
import { collectCoreConfigAssignments } from "./runtime-config-collectors-core.js";
import { collectPluginConfigAssignments } from "./runtime-config-collectors-plugins.js";
export function collectConfigAssignments(params) {
    const defaults = params.context.sourceConfig.secrets?.defaults;
    collectCoreConfigAssignments({
        config: params.config,
        defaults,
        context: params.context,
    });
    collectChannelConfigAssignments({
        config: params.config,
        defaults,
        context: params.context,
    });
    collectPluginConfigAssignments({
        config: params.config,
        defaults,
        context: params.context,
        loadablePluginOrigins: params.loadablePluginOrigins,
    });
}
