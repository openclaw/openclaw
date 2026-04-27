import { type ConfigWriteOptions } from "./io.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "./types.js";
export type ConfigMutationBase = "runtime" | "source";
export declare class ConfigMutationConflictError extends Error {
    readonly currentHash: string | null;
    constructor(message: string, params: {
        currentHash: string | null;
    });
}
export type ConfigReplaceResult = {
    path: string;
    previousHash: string | null;
    snapshot: ConfigFileSnapshot;
    nextConfig: OpenClawConfig;
};
export declare function replaceConfigFile(params: {
    nextConfig: OpenClawConfig;
    baseHash?: string;
    snapshot?: ConfigFileSnapshot;
    writeOptions?: ConfigWriteOptions;
}): Promise<ConfigReplaceResult>;
export declare function mutateConfigFile<T = void>(params: {
    base?: ConfigMutationBase;
    baseHash?: string;
    writeOptions?: ConfigWriteOptions;
    mutate: (draft: OpenClawConfig, context: {
        snapshot: ConfigFileSnapshot;
        previousHash: string | null;
    }) => Promise<T | void> | T | void;
}): Promise<ConfigReplaceResult & {
    result: T | undefined;
}>;
