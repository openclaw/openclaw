import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginWebContentExtractorEntry } from "./web-content-extractor-types.js";
export declare function resolvePluginWebContentExtractors(params?: {
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    onlyPluginIds?: readonly string[];
}): PluginWebContentExtractorEntry[];
