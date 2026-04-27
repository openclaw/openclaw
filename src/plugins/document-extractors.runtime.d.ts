import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginDocumentExtractorEntry } from "./document-extractor-types.js";
export declare function resolvePluginDocumentExtractors(params?: {
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    onlyPluginIds?: readonly string[];
}): PluginDocumentExtractorEntry[];
