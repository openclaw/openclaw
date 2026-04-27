import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
export declare function normalizePluginConfigId(id: unknown): string;
export declare function isWorkspacePluginAllowedByConfig(params: {
    config: OpenClawConfig | undefined;
    isImplicitlyAllowed?: (pluginId: string) => boolean;
    plugin: PluginManifestRecord;
}): boolean;
