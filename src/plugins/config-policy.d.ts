import type { OpenClawConfig } from "../config/types.openclaw.js";
import { type PluginActivationSource, type PluginActivationStateLike } from "./config-activation-shared.js";
import { hasExplicitPluginConfig as hasExplicitPluginConfigShared, isBundledChannelEnabledByChannelConfig as isBundledChannelEnabledByChannelConfigShared, type NormalizePluginId, type NormalizedPluginsConfig as SharedNormalizedPluginsConfig } from "./config-normalization-shared.js";
import type { PluginKind } from "./plugin-kind.types.js";
import type { PluginOrigin } from "./plugin-origin.types.js";
export type { PluginActivationSource };
export type PluginActivationState = PluginActivationStateLike;
export type NormalizedPluginsConfig = SharedNormalizedPluginsConfig;
export declare function normalizePluginsConfigWithResolver(config?: OpenClawConfig["plugins"], normalizePluginId?: NormalizePluginId): NormalizedPluginsConfig;
export declare function resolvePluginActivationState(params: {
    id: string;
    origin: PluginOrigin;
    config: NormalizedPluginsConfig;
    rootConfig?: OpenClawConfig;
    enabledByDefault?: boolean;
    sourceConfig?: NormalizedPluginsConfig;
    sourceRootConfig?: OpenClawConfig;
    autoEnabledReason?: string;
}): PluginActivationState;
export declare const hasExplicitPluginConfig: typeof hasExplicitPluginConfigShared;
export declare const resolveEnableState: (id: string, origin: PluginOrigin, config: SharedNormalizedPluginsConfig, enabledByDefault?: boolean) => {
    enabled: boolean;
    reason?: string;
};
export declare const isBundledChannelEnabledByChannelConfig: typeof isBundledChannelEnabledByChannelConfigShared;
type PolicyEffectiveActivationParams = {
    id: string;
    origin: PluginOrigin;
    config: NormalizedPluginsConfig;
    rootConfig?: OpenClawConfig;
    enabledByDefault?: boolean;
    sourceConfig?: NormalizedPluginsConfig;
    sourceRootConfig?: OpenClawConfig;
    autoEnabledReason?: string;
};
export declare const resolveEffectiveEnableState: (params: PolicyEffectiveActivationParams) => {
    enabled: boolean;
    reason?: string;
};
export declare function resolveEffectivePluginActivationState(params: PolicyEffectiveActivationParams): PluginActivationState;
export declare function resolveMemorySlotDecision(params: {
    id: string;
    kind?: PluginKind | PluginKind[];
    slot: string | null | undefined;
    selectedId: string | null;
}): {
    enabled: boolean;
    reason?: string;
    selected?: boolean;
};
