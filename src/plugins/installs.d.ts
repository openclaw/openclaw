import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { type NpmSpecResolution } from "../infra/install-source-utils.js";
export type PluginInstallUpdate = PluginInstallRecord & {
    pluginId: string;
};
export declare function buildNpmResolutionInstallFields(resolution?: NpmSpecResolution): Pick<PluginInstallRecord, "resolvedName" | "resolvedVersion" | "resolvedSpec" | "integrity" | "shasum" | "resolvedAt">;
export declare function recordPluginInstall(cfg: OpenClawConfig, update: PluginInstallUpdate): OpenClawConfig;
