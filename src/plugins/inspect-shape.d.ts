import type { PluginRegistry } from "./registry.js";
export type PluginCapabilityKind = "cli-backend" | "text-inference" | "speech" | "realtime-transcription" | "realtime-voice" | "media-understanding" | "image-generation" | "web-search" | "agent-harness" | "context-engine" | "channel";
export type PluginInspectShape = "hook-only" | "plain-capability" | "hybrid-capability" | "non-capability";
export type PluginCapabilityEntry = {
    kind: PluginCapabilityKind;
    ids: string[];
};
export type PluginShapeSummary = {
    shape: PluginInspectShape;
    capabilityMode: "none" | "plain" | "hybrid";
    capabilityCount: number;
    capabilities: PluginCapabilityEntry[];
    usesLegacyBeforeAgentStart: boolean;
};
export declare function buildPluginCapabilityEntries(plugin: PluginRegistry["plugins"][number]): PluginCapabilityEntry[];
export declare function derivePluginInspectShape(params: {
    capabilityCount: number;
    typedHookCount: number;
    customHookCount: number;
    toolCount: number;
    commandCount: number;
    cliCount: number;
    serviceCount: number;
    gatewayDiscoveryServiceCount: number;
    gatewayMethodCount: number;
    httpRouteCount: number;
}): PluginInspectShape;
export declare function buildPluginShapeSummary(params: {
    plugin: PluginRegistry["plugins"][number];
    report: Pick<PluginRegistry, "hooks" | "typedHooks" | "tools">;
}): PluginShapeSummary;
