import type { ChannelAccountSnapshot } from "../../channels/plugins/types.public.js";
export type ChannelAccountTokenSummaryRow = {
    account: unknown;
    enabled: boolean;
    snapshot: ChannelAccountSnapshot;
};
export declare function summarizeTokenConfig(params: {
    accounts: ChannelAccountTokenSummaryRow[];
    showSecrets: boolean;
}): {
    state: "ok" | "setup" | "warn" | null;
    detail: string | null;
};
