import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { RuntimeEnv } from "../../runtime.js";
import type { ChannelId } from "./channel-id.types.js";
import type { ChannelPairingAdapter } from "./pairing.types.js";
export declare function listPairingChannels(): ChannelId[];
export declare function getPairingAdapter(channelId: ChannelId): ChannelPairingAdapter | null;
export declare function requirePairingAdapter(channelId: ChannelId): ChannelPairingAdapter;
export declare function resolvePairingChannel(raw: unknown): ChannelId;
export declare function notifyPairingApproved(params: {
    channelId: ChannelId;
    id: string;
    cfg: OpenClawConfig;
    runtime?: RuntimeEnv;
    /** Extension channels can pass their adapter directly to bypass registry lookup. */
    pairingAdapter?: ChannelPairingAdapter;
}): Promise<void>;
