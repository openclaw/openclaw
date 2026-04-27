export declare const PUBLIC_SURFACE_SOURCE_EXTENSIONS: readonly [".ts", ".mts", ".js", ".mjs", ".cts", ".cjs"];
export declare function normalizeBundledPluginArtifactSubpath(artifactBasename: string): string;
export declare function normalizeBundledPluginDirName(dirName: string): string;
export declare function resolveBundledPluginSourcePublicSurfacePath(params: {
    sourceRoot: string;
    dirName: string;
    artifactBasename: string;
}): string | null;
export declare function resolveBundledPluginPublicSurfacePath(params: {
    rootDir: string;
    dirName: string;
    artifactBasename: string;
    env?: NodeJS.ProcessEnv;
    bundledPluginsDir?: string;
}): string | null;
