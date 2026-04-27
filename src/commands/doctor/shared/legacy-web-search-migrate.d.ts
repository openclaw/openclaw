import type { OpenClawConfig } from "../../../config/types.openclaw.js";
export declare function listLegacyWebSearchConfigPaths(raw: unknown): string[];
export declare function normalizeLegacyWebSearchConfig<T>(raw: T): T;
export declare function migrateLegacyWebSearchConfig<T>(raw: T): {
    config: T;
    changes: string[];
};
export declare function resolvePluginWebSearchConfig(config: OpenClawConfig | undefined, pluginId: string): Record<string, unknown> | undefined;
