import type { OpenClawConfig } from "./types.openclaw.js";
type WarnState = {
    warned: boolean;
};
export declare function resolveNormalizedProviderModelMaxTokens(params: {
    providerId: string;
    modelId: string;
    contextWindow: number;
    rawMaxTokens: number;
}): number;
export type SessionDefaultsOptions = {
    warn?: (message: string) => void;
    warnState?: WarnState;
};
export declare function applyMessageDefaults(cfg: OpenClawConfig): OpenClawConfig;
export declare function applySessionDefaults(cfg: OpenClawConfig, options?: SessionDefaultsOptions): OpenClawConfig;
export declare function applyTalkConfigNormalization(config: OpenClawConfig): OpenClawConfig;
export declare function applyModelDefaults(cfg: OpenClawConfig): OpenClawConfig;
export declare function applyAgentDefaults(cfg: OpenClawConfig): OpenClawConfig;
export declare function applyLoggingDefaults(cfg: OpenClawConfig): OpenClawConfig;
export declare function applyContextPruningDefaults(cfg: OpenClawConfig): OpenClawConfig;
export declare function applyCompactionDefaults(cfg: OpenClawConfig): OpenClawConfig;
export declare function resetSessionDefaultsWarningForTests(): void;
export {};
