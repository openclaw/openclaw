import type { OpenClawConfig, ResolvedSourceConfig, RuntimeConfig } from "./types.js";
export type ConfigMaterializationMode = "load" | "missing" | "snapshot";
export declare function asResolvedSourceConfig(config: OpenClawConfig): ResolvedSourceConfig;
export declare function asRuntimeConfig(config: OpenClawConfig): RuntimeConfig;
export declare function materializeRuntimeConfig(config: OpenClawConfig, mode: ConfigMaterializationMode): RuntimeConfig;
