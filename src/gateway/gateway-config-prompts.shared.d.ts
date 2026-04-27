import type { OpenClawConfig } from "../config/types.openclaw.js";
export declare const TAILSCALE_EXPOSURE_OPTIONS: readonly [{
    readonly value: "off";
    readonly label: "Off";
    readonly hint: "No Tailscale exposure";
}, {
    readonly value: "serve";
    readonly label: "Serve";
    readonly hint: "Private HTTPS for your tailnet (devices on Tailscale)";
}, {
    readonly value: "funnel";
    readonly label: "Funnel";
    readonly hint: "Public HTTPS via Tailscale Funnel (internet)";
}];
export declare const TAILSCALE_MISSING_BIN_NOTE_LINES: readonly ["Tailscale binary not found in PATH or /Applications.", "Ensure Tailscale is installed from:", "  https://tailscale.com/download/mac", "", "You can continue setup, but serve/funnel will fail at runtime."];
export declare const TAILSCALE_DOCS_LINES: readonly ["Docs:", "https://docs.openclaw.ai/gateway/tailscale", "https://docs.openclaw.ai/web"];
export declare function buildTailnetHttpsOrigin(rawHost: string): string | null;
export declare function appendAllowedOrigin(existing: string[] | undefined, origin: string): string[];
export declare function maybeAddTailnetOriginToControlUiAllowedOrigins(params: {
    config: OpenClawConfig;
    tailscaleMode: string;
    tailscaleBin?: string | null;
}): Promise<OpenClawConfig>;
