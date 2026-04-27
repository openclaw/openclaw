import type { OpenClawConfig } from "../config/types.openclaw.js";
export declare function getScopedChannelsCommandSecretTargets(params: {
    config: OpenClawConfig;
    channel?: string | null;
    accountId?: string | null;
}): {
    targetIds: Set<string>;
    allowedPaths?: Set<string>;
};
export declare function getQrRemoteCommandSecretTargetIds(): Set<string>;
export declare function getChannelsCommandSecretTargetIds(): Set<string>;
export declare function getConfiguredChannelsCommandSecretTargetIds(config: OpenClawConfig, env?: NodeJS.ProcessEnv): Set<string>;
export declare function getModelsCommandSecretTargetIds(): Set<string>;
export declare function getAgentRuntimeCommandSecretTargetIds(params?: {
    includeChannelTargets?: boolean;
}): Set<string>;
export declare function getStatusCommandSecretTargetIds(config?: OpenClawConfig, env?: NodeJS.ProcessEnv): Set<string>;
export declare function getSecurityAuditCommandSecretTargetIds(): Set<string>;
