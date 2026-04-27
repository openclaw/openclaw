export type ExtraGatewayService = {
    platform: "darwin" | "linux" | "win32";
    label: string;
    detail: string;
    scope: "user" | "system";
    marker?: "openclaw" | "clawdbot";
    legacy?: boolean;
};
export type FindExtraGatewayServicesOptions = {
    deep?: boolean;
};
declare const EXTRA_MARKERS: readonly ["openclaw", "clawdbot"];
export declare function renderGatewayServiceCleanupHints(env?: Record<string, string | undefined>): string[];
type Marker = (typeof EXTRA_MARKERS)[number];
export declare function detectMarkerLineWithGateway(contents: string): Marker | null;
export declare function findExtraGatewayServices(env: Record<string, string | undefined>, opts?: FindExtraGatewayServicesOptions): Promise<ExtraGatewayService[]>;
export {};
