import type { OpenClawConfig } from "../config/types.openclaw.js";
export declare function resolveFileNpmSpecToLocalPath(raw: string): {
    ok: true;
    path: string;
} | {
    ok: false;
    error: string;
} | null;
export declare function applySlotSelectionForPlugin(config: OpenClawConfig, pluginId: string): {
    config: OpenClawConfig;
    warnings: string[];
};
export declare function createPluginInstallLogger(): {
    info: (msg: string) => void;
    warn: (msg: string) => void;
};
export declare function createHookPackInstallLogger(): {
    info: (msg: string) => void;
    warn: (msg: string) => void;
};
export declare function enableInternalHookEntries(config: OpenClawConfig, hookNames: string[]): OpenClawConfig;
export declare function formatPluginInstallWithHookFallbackError(pluginError: string, hookError: string): string;
export declare function logHookPackRestartHint(): void;
export declare function logSlotWarnings(warnings: string[]): void;
export declare function buildPreferredClawHubSpec(raw: string): string | null;
export declare const PREFERRED_CLAWHUB_FALLBACK_DECISION: {
    readonly FALLBACK_TO_NPM: "fallback_to_npm";
    readonly STOP: "stop";
};
export type PreferredClawHubFallbackDecision = (typeof PREFERRED_CLAWHUB_FALLBACK_DECISION)[keyof typeof PREFERRED_CLAWHUB_FALLBACK_DECISION];
export declare function decidePreferredClawHubFallback(params: {
    code?: string;
}): PreferredClawHubFallbackDecision;
