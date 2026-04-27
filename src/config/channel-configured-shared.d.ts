import type { OpenClawConfig } from "./config.js";
export declare function resolveChannelConfigRecord(cfg: OpenClawConfig, channelId: string): Record<string, unknown> | null;
export declare function hasMeaningfulChannelConfigShallow(value: unknown): boolean;
export declare function isStaticallyChannelConfigured(cfg: OpenClawConfig, channelId: string, env?: NodeJS.ProcessEnv): boolean;
