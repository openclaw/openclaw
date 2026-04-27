import { hasKind } from "./slots.js";
export function buildPluginCapabilityEntries(plugin) {
    return [
        { kind: "cli-backend", ids: plugin.cliBackendIds ?? [] },
        { kind: "text-inference", ids: plugin.providerIds },
        { kind: "speech", ids: plugin.speechProviderIds },
        { kind: "realtime-transcription", ids: plugin.realtimeTranscriptionProviderIds },
        { kind: "realtime-voice", ids: plugin.realtimeVoiceProviderIds },
        { kind: "media-understanding", ids: plugin.mediaUnderstandingProviderIds },
        { kind: "image-generation", ids: plugin.imageGenerationProviderIds },
        { kind: "web-search", ids: plugin.webSearchProviderIds },
        { kind: "agent-harness", ids: plugin.agentHarnessIds },
        {
            kind: "context-engine",
            ids: plugin.status === "loaded" && hasKind(plugin.kind, "context-engine")
                ? (plugin.contextEngineIds ?? [])
                : [],
        },
        { kind: "channel", ids: plugin.channelIds },
    ].filter((entry) => entry.ids.length > 0);
}
export function derivePluginInspectShape(params) {
    if (params.capabilityCount > 1) {
        return "hybrid-capability";
    }
    if (params.capabilityCount === 1) {
        return "plain-capability";
    }
    const hasOnlyHooks = params.typedHookCount + params.customHookCount > 0 &&
        params.toolCount === 0 &&
        params.commandCount === 0 &&
        params.cliCount === 0 &&
        params.serviceCount === 0 &&
        params.gatewayDiscoveryServiceCount === 0 &&
        params.gatewayMethodCount === 0 &&
        params.httpRouteCount === 0;
    if (hasOnlyHooks) {
        return "hook-only";
    }
    return "non-capability";
}
export function buildPluginShapeSummary(params) {
    const capabilities = buildPluginCapabilityEntries(params.plugin);
    const typedHookCount = params.report.typedHooks.filter((entry) => entry.pluginId === params.plugin.id).length;
    const customHookCount = params.report.hooks.filter((entry) => entry.pluginId === params.plugin.id).length;
    const toolCount = params.report.tools.filter((entry) => entry.pluginId === params.plugin.id).length;
    const capabilityCount = capabilities.length;
    const shape = derivePluginInspectShape({
        capabilityCount,
        typedHookCount,
        customHookCount,
        toolCount,
        commandCount: params.plugin.commands.length,
        cliCount: params.plugin.cliCommands.length,
        serviceCount: params.plugin.services.length,
        gatewayDiscoveryServiceCount: params.plugin.gatewayDiscoveryServiceIds.length,
        gatewayMethodCount: params.plugin.gatewayMethods.length,
        httpRouteCount: params.plugin.httpRoutes,
    });
    return {
        shape,
        capabilityMode: capabilityCount === 0 ? "none" : capabilityCount === 1 ? "plain" : "hybrid",
        capabilityCount,
        capabilities,
        usesLegacyBeforeAgentStart: params.report.typedHooks.some((entry) => entry.pluginId === params.plugin.id && entry.hookName === "before_agent_start"),
    };
}
