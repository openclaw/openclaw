import type { OpenClawConfig } from "./types.js";
export type RuntimeConfigSnapshotRefreshParams = {
    sourceConfig: OpenClawConfig;
};
export type RuntimeConfigSnapshotRefreshHandler = {
    refresh: (params: RuntimeConfigSnapshotRefreshParams) => boolean | Promise<boolean>;
    clearOnRefreshFailure?: () => void;
};
export type RuntimeConfigWriteNotification = {
    configPath: string;
    sourceConfig: OpenClawConfig;
    runtimeConfig: OpenClawConfig;
    persistedHash: string;
    writtenAtMs: number;
};
export declare function setRuntimeConfigSnapshot(config: OpenClawConfig, sourceConfig?: OpenClawConfig): void;
export declare function resetConfigRuntimeState(): void;
export declare function clearRuntimeConfigSnapshot(): void;
export declare function getRuntimeConfigSnapshot(): OpenClawConfig | null;
export declare function getRuntimeConfigSourceSnapshot(): OpenClawConfig | null;
export declare function selectApplicableRuntimeConfig(params: {
    inputConfig?: OpenClawConfig;
    runtimeConfig?: OpenClawConfig | null;
    runtimeSourceConfig?: OpenClawConfig | null;
}): OpenClawConfig | undefined;
export declare function setRuntimeConfigSnapshotRefreshHandler(refreshHandler: RuntimeConfigSnapshotRefreshHandler | null): void;
export declare function getRuntimeConfigSnapshotRefreshHandler(): RuntimeConfigSnapshotRefreshHandler | null;
export declare function registerRuntimeConfigWriteListener(listener: (event: RuntimeConfigWriteNotification) => void): () => void;
export declare function notifyRuntimeConfigWriteListeners(event: RuntimeConfigWriteNotification): void;
export declare function loadPinnedRuntimeConfig(loadFresh: () => OpenClawConfig): OpenClawConfig;
export declare function finalizeRuntimeSnapshotWrite(params: {
    nextSourceConfig: OpenClawConfig;
    hadRuntimeSnapshot: boolean;
    hadBothSnapshots: boolean;
    loadFreshConfig: () => OpenClawConfig;
    notifyCommittedWrite: () => void;
    createRefreshError: (detail: string, cause: unknown) => Error;
    formatRefreshError: (error: unknown) => string;
}): Promise<void>;
