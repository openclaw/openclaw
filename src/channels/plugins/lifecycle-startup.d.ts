import type { OpenClawConfig } from "../../config/types.openclaw.js";
type ChannelStartupLogger = {
    info?: (message: string) => void;
    warn?: (message: string) => void;
};
export declare function runChannelPluginStartupMaintenance(params: {
    cfg: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
    log: ChannelStartupLogger;
    trigger?: string;
    logPrefix?: string;
}): Promise<void>;
export {};
