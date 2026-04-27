import type { OpenClawConfig } from "../config/types.openclaw.js";
import { openBoundaryFileSync } from "../infra/boundary-file-read.js";
import type { PluginBundleFormat } from "./manifest-types.js";
type ReadBundleJsonResult = {
    ok: true;
    raw: Record<string, unknown>;
} | {
    ok: false;
    error: string;
};
export type BundleServerRuntimeSupport = {
    hasSupportedServer: boolean;
    supportedServerNames: string[];
    unsupportedServerNames: string[];
    diagnostics: string[];
};
export declare function readBundleJsonObject(params: {
    rootDir: string;
    relativePath: string;
    onOpenFailure?: (failure: Extract<ReturnType<typeof openBoundaryFileSync>, {
        ok: false;
    }>) => ReadBundleJsonResult;
}): ReadBundleJsonResult;
export declare function resolveBundleJsonOpenFailure(params: {
    failure: Extract<ReturnType<typeof openBoundaryFileSync>, {
        ok: false;
    }>;
    relativePath: string;
    allowMissing?: boolean;
}): ReadBundleJsonResult;
export declare function inspectBundleServerRuntimeSupport<TConfig>(params: {
    loaded: {
        config: TConfig;
        diagnostics: string[];
    };
    resolveServers: (config: TConfig) => Record<string, Record<string, unknown>>;
}): BundleServerRuntimeSupport;
export declare function loadEnabledBundleConfig<TConfig, TDiagnostic>(params: {
    workspaceDir: string;
    cfg?: OpenClawConfig;
    createEmptyConfig: () => TConfig;
    loadBundleConfig: (params: {
        pluginId: string;
        rootDir: string;
        bundleFormat: PluginBundleFormat;
    }) => {
        config: TConfig;
        diagnostics: string[];
    };
    createDiagnostic: (pluginId: string, message: string) => TDiagnostic;
}): {
    config: TConfig;
    diagnostics: TDiagnostic[];
};
export {};
