import type { GatewayBindMode } from "../config/types.js";
export declare function summarizeDisplayNetworkError(error: unknown): string;
export declare function fallbackBindHostForDisplay(bindMode: GatewayBindMode, customBindHost?: string): string;
export declare function pickBestEffortPrimaryLanIPv4(): string | undefined;
export declare function inspectBestEffortPrimaryTailnetIPv4(params?: {
    warningPrefix?: string;
}): {
    tailnetIPv4: string | undefined;
    warning?: string;
};
export declare function resolveBestEffortGatewayBindHostForDisplay(params: {
    bindMode: GatewayBindMode;
    customBindHost?: string;
    warningPrefix?: string;
}): Promise<{
    bindHost: string;
    warning?: string;
}>;
