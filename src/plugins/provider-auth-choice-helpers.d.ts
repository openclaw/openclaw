import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ProviderAuthMethod, ProviderPlugin } from "./types.js";
export declare function resolveProviderMatch(providers: ProviderPlugin[], rawProvider?: string): ProviderPlugin | null;
export declare function pickAuthMethod(provider: ProviderPlugin, rawMethod?: string): ProviderAuthMethod | null;
export declare function mergeConfigPatch<T>(base: T, patch: unknown): T;
export declare function applyProviderAuthConfigPatch(cfg: OpenClawConfig, patch: unknown, options?: {
    replaceDefaultModels?: boolean;
}): OpenClawConfig;
export declare function applyDefaultModel(cfg: OpenClawConfig, model: string, opts?: {
    preserveExistingPrimary?: boolean;
}): OpenClawConfig;
