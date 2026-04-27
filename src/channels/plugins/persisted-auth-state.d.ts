import type { OpenClawConfig } from "../../config/types.openclaw.js";
export declare function listBundledChannelIdsWithPersistedAuthState(): string[];
export declare function hasBundledChannelPersistedAuthState(params: {
    channelId: string;
    cfg: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
}): boolean;
