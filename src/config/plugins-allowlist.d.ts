type PluginAllowlistConfigCarrier = {
    plugins?: {
        allow?: string[];
    };
};
export declare function ensurePluginAllowlisted<T extends PluginAllowlistConfigCarrier>(cfg: T, pluginId: string): T;
export {};
