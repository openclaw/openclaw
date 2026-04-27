import type { OpenClawConfig } from "../../../config/types.openclaw.js";
export declare function listLegacyWebFetchConfigPaths(raw: unknown): string[];
export declare function normalizeLegacyWebFetchConfig<T>(raw: T): T;
export declare function migrateLegacyWebFetchConfig<T>(raw: T): {
    config: T;
    changes: string[];
};
export declare function resolvePluginWebFetchConfig(config: OpenClawConfig | undefined, pluginId: string): Record<string, unknown> | undefined;
