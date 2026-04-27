import { normalizeOptionalString } from "../shared/string-coerce.js";
export { normalizeOptionalString as trimBundledPluginString };
export declare function normalizeBundledPluginStringList(value: unknown): string[];
export declare function rewriteBundledPluginEntryToBuiltPath(entry: string | undefined): string | undefined;
export declare function deriveBundledPluginIdHint(params: {
    entryPath: string;
    manifestId: string;
    packageName?: string;
    hasMultipleExtensions: boolean;
}): string;
export declare function collectBundledPluginPublicSurfaceArtifacts(params: {
    pluginDir: string;
    sourceEntry: string;
    setupEntry?: string;
}): readonly string[] | undefined;
export declare function collectBundledPluginRuntimeSidecarArtifacts(publicSurfaceArtifacts: readonly string[] | undefined): readonly string[] | undefined;
export declare function resolveBundledPluginScanDir(params: {
    packageRoot: string;
    runningFromBuiltArtifact: boolean;
}): string | undefined;
