export type BundledChannelRootScope = {
    packageRoot: string;
    cacheKey: string;
    pluginsDir?: string;
};
export declare function resolveBundledChannelRootScope(env?: NodeJS.ProcessEnv): BundledChannelRootScope;
