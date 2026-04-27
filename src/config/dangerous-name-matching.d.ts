import type { OpenClawConfig } from "./config.js";
export type DangerousNameMatchingConfig = {
    dangerouslyAllowNameMatching?: boolean;
};
export type ProviderDangerousNameMatchingScope = {
    prefix: string;
    account: Record<string, unknown>;
    dangerousNameMatchingEnabled: boolean;
    dangerousFlagPath: string;
};
export type DangerousNameMatchingResolverInput = {
    providerConfig?: DangerousNameMatchingConfig | null | undefined;
    accountConfig?: DangerousNameMatchingConfig | null | undefined;
};
export declare function isDangerousNameMatchingEnabled(config: DangerousNameMatchingConfig | null | undefined): boolean;
export declare function resolveDangerousNameMatchingEnabled(input: DangerousNameMatchingResolverInput): boolean;
export declare function collectProviderDangerousNameMatchingScopes(cfg: OpenClawConfig, provider: string): ProviderDangerousNameMatchingScope[];
