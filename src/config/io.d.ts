import fs from "node:fs";
import JSON5 from "json5";
import { clearRuntimeConfigSnapshot as clearRuntimeConfigSnapshotState, getRuntimeConfigSnapshot as getRuntimeConfigSnapshotState, getRuntimeConfigSourceSnapshot as getRuntimeConfigSourceSnapshotState, resetConfigRuntimeState as resetConfigRuntimeStateState, selectApplicableRuntimeConfig, setRuntimeConfigSnapshot as setRuntimeConfigSnapshotState, setRuntimeConfigSnapshotRefreshHandler as setRuntimeConfigSnapshotRefreshHandlerState, type RuntimeConfigWriteNotification } from "./runtime-snapshot.js";
import type { OpenClawConfig, ConfigFileSnapshot } from "./types.js";
export { clearRuntimeConfigSnapshotState as clearRuntimeConfigSnapshot, getRuntimeConfigSnapshotState as getRuntimeConfigSnapshot, getRuntimeConfigSourceSnapshotState as getRuntimeConfigSourceSnapshot, resetConfigRuntimeStateState as resetConfigRuntimeState, selectApplicableRuntimeConfig, setRuntimeConfigSnapshotState as setRuntimeConfigSnapshot, setRuntimeConfigSnapshotRefreshHandlerState as setRuntimeConfigSnapshotRefreshHandler, };
export { CircularIncludeError, ConfigIncludeError } from "./includes.js";
export { MissingEnvVarError } from "./env-substitution.js";
export { resolveShellEnvExpectedKeys } from "./shell-env-expected-keys.js";
export type ParseConfigJson5Result = {
    ok: true;
    parsed: unknown;
} | {
    ok: false;
    error: string;
};
export type ConfigWriteOptions = {
    /**
     * Read-time env snapshot used to validate `${VAR}` restoration decisions.
     * If omitted, write falls back to current process env.
     */
    envSnapshotForRestore?: Record<string, string | undefined>;
    /**
     * Optional safety check: only use envSnapshotForRestore when writing the
     * same config file path that produced the snapshot.
     */
    expectedConfigPath?: string;
    /**
     * Paths that must be explicitly removed from the persisted file payload,
     * even if schema/default normalization reintroduces them.
     */
    unsetPaths?: string[][];
    /**
     * Internal fast path for callers that already hold a fresh config snapshot.
     * Avoids rereading the full config just to prepare an immediate write.
     */
    baseSnapshot?: ConfigFileSnapshot;
    /**
     * Internal one-shot CLI fast path. When no runtime snapshot is active, skip
     * the post-write runtime snapshot refresh/reload tail entirely.
     */
    skipRuntimeSnapshotRefresh?: boolean;
    /**
     * Allow intentionally destructive config writes, such as explicit reset flows.
     * Normal writers must keep this false so clobbers are rejected before disk commit.
     */
    allowDestructiveWrite?: boolean;
    /**
     * Suppress human-readable output logs (overwrite/anomaly messages).
     * Useful when the caller wants machine-readable output only (--json mode).
     */
    skipOutputLogs?: boolean;
};
export type ReadConfigFileSnapshotForWriteResult = {
    snapshot: ConfigFileSnapshot;
    writeOptions: ConfigWriteOptions;
};
export type ConfigWriteNotification = RuntimeConfigWriteNotification;
export declare class ConfigRuntimeRefreshError extends Error {
    constructor(message: string, options?: {
        cause?: unknown;
    });
}
export declare function resolveConfigSnapshotHash(snapshot: {
    hash?: string;
    raw?: string | null;
}): string | null;
export type ConfigIoDeps = {
    fs?: typeof fs;
    json5?: typeof JSON5;
    env?: NodeJS.ProcessEnv;
    homedir?: () => string;
    configPath?: string;
    logger?: Pick<typeof console, "error" | "warn">;
};
export declare function parseConfigJson5(raw: string, json5?: {
    parse: (value: string) => unknown;
}): ParseConfigJson5Result;
export declare function createConfigIO(overrides?: ConfigIoDeps & {
    pluginValidation?: "full" | "skip";
}): {
    configPath: string;
    loadConfig: () => OpenClawConfig;
    readBestEffortConfig: () => Promise<OpenClawConfig>;
    readSourceConfigBestEffort: () => Promise<OpenClawConfig>;
    readConfigFileSnapshot: () => Promise<ConfigFileSnapshot>;
    readConfigFileSnapshotForWrite: () => Promise<ReadConfigFileSnapshotForWriteResult>;
    promoteConfigSnapshotToLastKnownGood: (snapshot: ConfigFileSnapshot) => Promise<boolean>;
    recoverConfigFromLastKnownGood: (params: {
        snapshot: ConfigFileSnapshot;
        reason: string;
    }) => Promise<boolean>;
    recoverConfigFromJsonRootSuffix: (snapshot: ConfigFileSnapshot) => Promise<boolean>;
    writeConfigFile: (cfg: OpenClawConfig, options?: ConfigWriteOptions) => Promise<{
        persistedHash: string;
        persistedConfig: OpenClawConfig;
    }>;
};
export declare function clearConfigCache(): void;
export declare function registerConfigWriteListener(listener: (event: ConfigWriteNotification) => void): () => void;
export declare function projectConfigOntoRuntimeSourceSnapshot(config: OpenClawConfig): OpenClawConfig;
export declare function loadConfig(): OpenClawConfig;
export declare function getRuntimeConfig(): OpenClawConfig;
export declare function readBestEffortConfig(): Promise<OpenClawConfig>;
export declare function readSourceConfigBestEffort(): Promise<OpenClawConfig>;
export declare function readConfigFileSnapshot(): Promise<ConfigFileSnapshot>;
export declare function promoteConfigSnapshotToLastKnownGood(snapshot: ConfigFileSnapshot): Promise<boolean>;
export declare function recoverConfigFromLastKnownGood(params: {
    snapshot: ConfigFileSnapshot;
    reason: string;
}): Promise<boolean>;
export declare function recoverConfigFromJsonRootSuffix(snapshot: ConfigFileSnapshot): Promise<boolean>;
export declare function readSourceConfigSnapshot(): Promise<ConfigFileSnapshot>;
export declare function readConfigFileSnapshotForWrite(): Promise<ReadConfigFileSnapshotForWriteResult>;
export declare function readSourceConfigSnapshotForWrite(): Promise<ReadConfigFileSnapshotForWriteResult>;
export declare function writeConfigFile(cfg: OpenClawConfig, options?: ConfigWriteOptions): Promise<void>;
