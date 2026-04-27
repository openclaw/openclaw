import type { OpenClawConfig } from "../config/types.openclaw.js";
export declare function resolveProviderAuthLoginCommand(params: {
    provider: string;
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
}): string | undefined;
export declare function buildProviderAuthRecoveryHint(params: {
    provider: string;
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    includeConfigure?: boolean;
    includeEnvVar?: boolean;
}): string;
