import { listConfiguredBindings } from "../../config/bindings.js";
import { getActivePluginChannelRegistryVersion, requireActivePluginChannelRegistry, } from "../../plugins/runtime.js";
import { pickFirstExistingAgentId } from "../../routing/resolve-route.js";
import { normalizeOptionalLowercaseString, normalizeOptionalString, } from "../../shared/string-coerce.js";
import { resolveChannelConfiguredBindingProvider } from "./binding-provider.js";
import { resolveConfiguredBindingConsumer } from "./configured-binding-consumers.js";
import { getChannelPlugin } from "./index.js";
const compiledRegistryCache = new WeakMap();
function resolveLoadedChannelPlugin(channel) {
    const normalized = normalizeOptionalLowercaseString(channel);
    if (!normalized) {
        return undefined;
    }
    return getChannelPlugin(normalized);
}
function resolveConfiguredBindingAdapter(channel) {
    const normalized = normalizeOptionalLowercaseString(channel);
    if (!normalized) {
        return null;
    }
    const plugin = resolveLoadedChannelPlugin(normalized);
    const provider = resolveChannelConfiguredBindingProvider(plugin);
    if (!plugin ||
        !provider ||
        !provider.compileConfiguredBinding ||
        !provider.matchInboundConversation) {
        return null;
    }
    return {
        channel: plugin.id,
        provider,
    };
}
function resolveBindingConversationId(binding) {
    return normalizeOptionalString(binding.match?.peer?.id) ?? null;
}
function compileConfiguredBindingTarget(params) {
    return params.provider.compileConfiguredBinding({
        binding: params.binding,
        conversationId: params.conversationId,
    });
}
function compileConfiguredBindingRule(params) {
    const agentId = pickFirstExistingAgentId(params.cfg, params.binding.agentId ?? "main");
    const consumer = resolveConfiguredBindingConsumer(params.binding);
    if (!consumer) {
        return null;
    }
    const targetFactory = consumer.buildTargetFactory({
        cfg: params.cfg,
        binding: params.binding,
        channel: params.channel,
        agentId,
        target: params.target,
        bindingConversationId: params.bindingConversationId,
    });
    if (!targetFactory) {
        return null;
    }
    return {
        channel: params.channel,
        accountPattern: normalizeOptionalString(params.binding.match.accountId),
        binding: params.binding,
        bindingConversationId: params.bindingConversationId,
        target: params.target,
        agentId,
        provider: params.provider,
        targetFactory,
    };
}
function pushCompiledRule(target, rule) {
    const existing = target.get(rule.channel);
    if (existing) {
        existing.push(rule);
        return;
    }
    target.set(rule.channel, [rule]);
}
function compileConfiguredBindingRegistry(params) {
    const rulesByChannel = new Map();
    for (const binding of listConfiguredBindings(params.cfg)) {
        const bindingConversationId = resolveBindingConversationId(binding);
        if (!bindingConversationId) {
            continue;
        }
        const resolvedChannel = resolveConfiguredBindingAdapter(binding.match.channel);
        if (!resolvedChannel) {
            continue;
        }
        const target = compileConfiguredBindingTarget({
            provider: resolvedChannel.provider,
            binding,
            conversationId: bindingConversationId,
        });
        if (!target) {
            continue;
        }
        const rule = compileConfiguredBindingRule({
            cfg: params.cfg,
            channel: resolvedChannel.channel,
            binding,
            target,
            bindingConversationId,
            provider: resolvedChannel.provider,
        });
        if (!rule) {
            continue;
        }
        pushCompiledRule(rulesByChannel, rule);
    }
    return {
        rulesByChannel,
    };
}
export function resolveCompiledBindingRegistry(cfg) {
    const activeRegistry = requireActivePluginChannelRegistry();
    const registryVersion = getActivePluginChannelRegistryVersion();
    const cached = compiledRegistryCache.get(cfg);
    if (cached?.registryVersion === registryVersion && cached.registryRef === activeRegistry) {
        return cached.registry;
    }
    const registry = compileConfiguredBindingRegistry({
        cfg,
    });
    compiledRegistryCache.set(cfg, {
        registryRef: activeRegistry,
        registryVersion,
        registry,
    });
    return registry;
}
export function primeCompiledBindingRegistry(cfg) {
    const activeRegistry = requireActivePluginChannelRegistry();
    const registry = compileConfiguredBindingRegistry({ cfg });
    compiledRegistryCache.set(cfg, {
        registryRef: activeRegistry,
        registryVersion: getActivePluginChannelRegistryVersion(),
        registry,
    });
    return registry;
}
export function countCompiledBindingRegistry(registry) {
    return {
        bindingCount: [...registry.rulesByChannel.values()].reduce((sum, rules) => sum + rules.length, 0),
        channelCount: registry.rulesByChannel.size,
    };
}
