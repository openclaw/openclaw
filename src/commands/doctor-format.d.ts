import type { GatewayServiceRuntime } from "../daemon/service-runtime.js";
type RuntimeHintOptions = {
    platform?: NodeJS.Platform;
    env?: Record<string, string | undefined>;
};
export declare function formatGatewayRuntimeSummary(runtime: GatewayServiceRuntime | undefined): string | null;
export declare function buildGatewayRuntimeHints(runtime: GatewayServiceRuntime | undefined, options?: RuntimeHintOptions): string[];
export {};
