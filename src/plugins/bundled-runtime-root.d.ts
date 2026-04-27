export declare function isBuiltBundledPluginRuntimeRoot(pluginRoot: string): boolean;
export declare function prepareBundledPluginRuntimeRoot(params: {
    pluginId: string;
    pluginRoot: string;
    modulePath: string;
    env?: NodeJS.ProcessEnv;
    logInstalled?: (installedSpecs: readonly string[]) => void;
}): {
    pluginRoot: string;
    modulePath: string;
};
