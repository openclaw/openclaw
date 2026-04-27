import { hasConfiguredChannelsForReadOnlyScope } from "../plugins/channel-plugin-ids.js";
import { executeStatusScanFromOverview } from "./status.scan-execute.ts";
import { resolveDefaultMemoryStorePath, resolveStatusMemoryStatusSnapshot, } from "./status.scan-memory.ts";
import { collectStatusScanOverview } from "./status.scan-overview.ts";
export async function scanStatusJsonWithPolicy(opts, runtime, policy) {
    const overview = await collectStatusScanOverview({
        commandName: policy.commandName,
        opts,
        showSecrets: false,
        runtime,
        allowMissingConfigFastPath: policy.allowMissingConfigFastPath,
        resolveHasConfiguredChannels: policy.resolveHasConfiguredChannels,
        includeChannelsData: false,
    });
    return await executeStatusScanFromOverview({
        overview,
        runtime,
        summary: {
            includeChannelSummary: policy.includeChannelSummary,
        },
        resolveMemory: policy.resolveMemory,
        channelIssues: [],
        channels: { rows: [], details: [] },
        pluginCompatibility: [],
    });
}
export async function scanStatusJsonFast(opts, runtime) {
    return await scanStatusJsonWithPolicy(opts, runtime, {
        commandName: "status --json",
        allowMissingConfigFastPath: true,
        includeChannelSummary: false,
        resolveHasConfiguredChannels: (cfg, sourceConfig) => hasConfiguredChannelsForReadOnlyScope({
            config: cfg,
            activationSourceConfig: sourceConfig,
            env: process.env,
            includePersistedAuthState: false,
        }),
        resolveMemory: async ({ cfg, agentStatus, memoryPlugin }) => opts.all
            ? await resolveStatusMemoryStatusSnapshot({
                cfg,
                agentStatus,
                memoryPlugin,
                requireDefaultStore: resolveDefaultMemoryStorePath,
            })
            : null,
    });
}
