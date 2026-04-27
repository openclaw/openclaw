import type { OpenClawConfig } from "../../config/types.openclaw.js";
/** Drain queued system events, format as `System:` lines, return the block (or undefined). */
export declare function drainFormattedSystemEvents(params: {
    cfg: OpenClawConfig;
    sessionKey: string;
    isMainSession: boolean;
    isNewSession: boolean;
}): Promise<string | undefined>;
