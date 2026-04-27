import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { CompiledConfiguredBinding, ConfiguredBindingRecordResolution, ConfiguredBindingRuleConfig, ConfiguredBindingTargetFactory } from "./binding-types.js";
import type { ChannelConfiguredBindingConversationRef } from "./types.adapters.js";
export type ParsedConfiguredBindingSessionKey = {
    channel: string;
    accountId: string;
};
export type ConfiguredBindingConsumer = {
    id: string;
    supports: (binding: ConfiguredBindingRuleConfig) => boolean;
    buildTargetFactory: (params: {
        cfg: OpenClawConfig;
        binding: ConfiguredBindingRuleConfig;
        channel: string;
        agentId: string;
        target: ChannelConfiguredBindingConversationRef;
        bindingConversationId: string;
    }) => ConfiguredBindingTargetFactory | null;
    parseSessionKey?: (params: {
        sessionKey: string;
    }) => ParsedConfiguredBindingSessionKey | null;
    matchesSessionKey?: (params: {
        sessionKey: string;
        compiledBinding: CompiledConfiguredBinding;
        accountId: string;
        materializedTarget: ConfiguredBindingRecordResolution;
    }) => boolean;
};
export declare function listConfiguredBindingConsumers(): ConfiguredBindingConsumer[];
export declare function resolveConfiguredBindingConsumer(binding: ConfiguredBindingRuleConfig): ConfiguredBindingConsumer | null;
export declare function registerConfiguredBindingConsumer(consumer: ConfiguredBindingConsumer): void;
export declare function unregisterConfiguredBindingConsumer(id: string): void;
