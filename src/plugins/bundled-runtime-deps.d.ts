import fs from "node:fs";
import type { OpenClawConfig } from "../config/types.openclaw.js";
export type RuntimeDepEntry = {
    name: string;
    version: string;
    pluginIds: string[];
};
export type RuntimeDepConflict = {
    name: string;
    versions: string[];
    pluginIdsByVersion: Map<string, string[]>;
};
export type BundledRuntimeDepsInstallParams = {
    installRoot: string;
    installExecutionRoot?: string;
    missingSpecs: string[];
    installSpecs?: string[];
};
export type BundledRuntimeDepsEnsureResult = {
    installedSpecs: string[];
    retainSpecs: string[];
};
export type BundledRuntimeDepsInstallRoot = {
    installRoot: string;
    external: boolean;
};
export type BundledRuntimeDepsNpmRunner = {
    command: string;
    args: string[];
    env?: NodeJS.ProcessEnv;
};
type RuntimeDepsLockOwner = {
    pid?: number;
    createdAtMs?: number;
    ownerFileState: "ok" | "missing" | "invalid";
    ownerFilePath: string;
    ownerFileMtimeMs?: number;
    ownerFileIsSymlink?: boolean;
    lockDirMtimeMs?: number;
};
declare function shouldRemoveRuntimeDepsLock(owner: Pick<RuntimeDepsLockOwner, "pid" | "createdAtMs" | "lockDirMtimeMs" | "ownerFileMtimeMs">, nowMs: number, isAlive?: (pid: number) => boolean): boolean;
declare function formatRuntimeDepsLockTimeoutMessage(params: {
    lockDir: string;
    owner: RuntimeDepsLockOwner;
    waitedMs: number;
    nowMs: number;
}): string;
export declare const __testing: {
    formatRuntimeDepsLockTimeoutMessage: typeof formatRuntimeDepsLockTimeoutMessage;
    shouldRemoveRuntimeDepsLock: typeof shouldRemoveRuntimeDepsLock;
};
export declare function resolveBundledRuntimeDependencyPackageRoot(pluginRoot: string): string | null;
export declare function registerBundledRuntimeDependencyNodePath(rootDir: string): void;
export declare function clearBundledRuntimeDependencyNodePaths(): void;
export declare function isWritableDirectory(dir: string): boolean;
export declare function createBundledRuntimeDepsInstallEnv(env: NodeJS.ProcessEnv, options?: {
    cacheDir?: string;
}): NodeJS.ProcessEnv;
export declare function createBundledRuntimeDepsInstallArgs(missingSpecs: readonly string[]): string[];
export declare function resolveBundledRuntimeDepsNpmRunner(params: {
    npmArgs: string[];
    env?: NodeJS.ProcessEnv;
    execPath?: string;
    existsSync?: typeof fs.existsSync;
    platform?: NodeJS.Platform;
}): BundledRuntimeDepsNpmRunner;
export declare function scanBundledPluginRuntimeDeps(params: {
    packageRoot: string;
    config?: OpenClawConfig;
    pluginIds?: readonly string[];
    includeConfiguredChannels?: boolean;
    env?: NodeJS.ProcessEnv;
}): {
    deps: RuntimeDepEntry[];
    missing: RuntimeDepEntry[];
    conflicts: RuntimeDepConflict[];
};
export declare function resolveBundledRuntimeDependencyPackageInstallRoot(packageRoot: string, options?: {
    env?: NodeJS.ProcessEnv;
    forceExternal?: boolean;
}): string;
export declare function resolveBundledRuntimeDependencyInstallRoot(pluginRoot: string, options?: {
    env?: NodeJS.ProcessEnv;
    forceExternal?: boolean;
}): string;
export declare function resolveBundledRuntimeDependencyInstallRootInfo(pluginRoot: string, options?: {
    env?: NodeJS.ProcessEnv;
    forceExternal?: boolean;
}): BundledRuntimeDepsInstallRoot;
export declare function createBundledRuntimeDependencyAliasMap(params: {
    pluginRoot: string;
    installRoot: string;
}): Record<string, string>;
export declare function installBundledRuntimeDeps(params: {
    installRoot: string;
    installExecutionRoot?: string;
    missingSpecs: string[];
    env: NodeJS.ProcessEnv;
}): void;
export declare function repairBundledRuntimeDepsInstallRoot(params: {
    installRoot: string;
    missingSpecs: string[];
    installSpecs: string[];
    env: NodeJS.ProcessEnv;
    installDeps?: (params: BundledRuntimeDepsInstallParams) => void;
}): {
    installSpecs: string[];
};
export declare function ensureBundledPluginRuntimeDeps(params: {
    pluginId: string;
    pluginRoot: string;
    env: NodeJS.ProcessEnv;
    config?: OpenClawConfig;
    retainSpecs?: readonly string[];
    installDeps?: (params: BundledRuntimeDepsInstallParams) => void;
}): BundledRuntimeDepsEnsureResult;
export {};
