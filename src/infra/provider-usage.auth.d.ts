import { type OpenClawConfig } from "../config/config.js";
import type { UsageProviderId } from "./provider-usage.types.js";
export type ProviderAuth = {
    provider: UsageProviderId;
    token: string;
    accountId?: string;
};
export declare function resolveProviderAuths(params: {
    providers: UsageProviderId[];
    auth?: ProviderAuth[];
    agentDir?: string;
    config?: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
    skipPluginAuthWithoutCredentialSource?: boolean;
}): Promise<ProviderAuth[]>;
