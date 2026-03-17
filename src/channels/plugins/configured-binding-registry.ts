import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { listConfiguredBindings } from "../../config/bindings.js";
import type { OpenClawConfig } from "../../config/config.js";
import { applyPluginAutoEnable } from "../../config/plugin-auto-enable.js";
import type { ConversationRef } from "../../infra/outbound/session-binding-service.js";
import { loadOpenClawPlugins } from "../../plugins/loader.js";
import { getActivePluginRegistry, getActivePluginRegistryVersion } from "../../plugins/runtime.js";
import { pickFirstExistingAgentId } from "../../routing/resolve-route.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../../routing/session-key.js";
import { resolveChannelConfiguredBindingProvider } from "./binding-provider.js";
import type {
  CompiledConfiguredBinding,
  ConfiguredBindingChannel,
  ConfiguredBindingRecordResolution,
  ConfiguredBindingResolution,
} from "./binding-types.js";
import { getChannelPluginCatalogEntry } from "./catalog.js";
import {
  listConfiguredBindingConsumers,
  resolveConfiguredBindingConsumer,
} from "./configured-binding-consumers.js";
import { getChannelPlugin } from "./index.js";
import type {
  ChannelConfiguredBindingConversationRef,
  ChannelConfiguredBindingMatch,
  ChannelConfiguredBindingProvider,
} from "./types.adapters.js";

type ChannelPluginLike = NonNullable<ReturnType<typeof getChannelPlugin>>;

type CompiledConfiguredBindingRegistry = {
  rulesByChannel: Map<ConfiguredBindingChannel, CompiledConfiguredBinding[]>;
};

type CachedCompiledConfiguredBindingRegistry = {
  registryVersion: number;
  registry: CompiledConfiguredBindingRegistry;
};

type ConfiguredBindingCompilerContext = {
  configForWorkspaceResolution: OpenClawConfig;
  workspaceDirs: string[];
  channelPluginCache: Map<string, ChannelPluginLike | null>;
  scopedPluginIdsCache: Map<string, string[]>;
  allowSnapshotFallback: boolean;
};

const compiledRegistryCache = new WeakMap<
  OpenClawConfig,
  CachedCompiledConfiguredBindingRegistry
>();

function findChannelPlugin(params: {
  registry:
    | {
        channels?: Array<{ plugin?: ChannelPluginLike | null } | null> | null;
      }
    | null
    | undefined;
  channel: string;
}): ChannelPluginLike | undefined {
  return (
    params.registry?.channels?.find((entry) => entry?.plugin?.id === params.channel)?.plugin ??
    undefined
  );
}

function resolveLoadedChannelPlugin(channel: string) {
  const normalized = channel.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }

  const current = getChannelPlugin(normalized as ConfiguredBindingChannel);
  if (current) {
    return current;
  }

  return findChannelPlugin({
    registry: getActivePluginRegistry(),
    channel: normalized,
  });
}

function listConfiguredBindingCompilerWorkspaces(cfg: OpenClawConfig): {
  configForWorkspaceResolution: OpenClawConfig;
  workspaceDirs: string[];
} {
  const autoEnabled = applyPluginAutoEnable({ config: cfg }).config;
  const seen = new Set<string>();
  const workspaceDirs: string[] = [];
  const addWorkspaceDir = (agentId: string) => {
    const workspaceDir = resolveAgentWorkspaceDir(autoEnabled, agentId);
    if (!workspaceDir || seen.has(workspaceDir)) {
      return;
    }
    seen.add(workspaceDir);
    workspaceDirs.push(workspaceDir);
  };

  addWorkspaceDir(resolveDefaultAgentId(autoEnabled));
  for (const binding of listConfiguredBindings(autoEnabled)) {
    addWorkspaceDir(pickFirstExistingAgentId(autoEnabled, binding.agentId ?? "main"));
  }

  return {
    configForWorkspaceResolution: autoEnabled,
    workspaceDirs,
  };
}

function createConfiguredBindingCompilerContext(
  cfg: OpenClawConfig,
  options?: { allowSnapshotFallback?: boolean },
): ConfiguredBindingCompilerContext {
  const { configForWorkspaceResolution, workspaceDirs } =
    listConfiguredBindingCompilerWorkspaces(cfg);
  return {
    configForWorkspaceResolution,
    workspaceDirs,
    channelPluginCache: new Map(),
    scopedPluginIdsCache: new Map(),
    allowSnapshotFallback: options?.allowSnapshotFallback ?? false,
  };
}

function resolveScopedPluginIdsForChannelSnapshot(params: {
  context: ConfiguredBindingCompilerContext;
  workspaceDir: string;
  channel: string;
}): string[] {
  const cacheKey = `${params.workspaceDir}\n${params.channel}`;
  const cached = params.context.scopedPluginIdsCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const catalogEntry = getChannelPluginCatalogEntry(params.channel, {
    workspaceDir: params.workspaceDir,
  });
  const pluginIds = Array.from(
    new Set(
      [catalogEntry?.pluginId, params.channel].filter((entry): entry is string => Boolean(entry)),
    ),
  );
  params.context.scopedPluginIdsCache.set(cacheKey, pluginIds);
  return pluginIds;
}

function resolveConfiguredBindingChannelPluginSnapshot(params: {
  context: ConfiguredBindingCompilerContext;
  channel: string;
}) {
  if (!params.context.allowSnapshotFallback) {
    return undefined;
  }
  const normalized = params.channel.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (params.context.channelPluginCache.has(normalized)) {
    return params.context.channelPluginCache.get(normalized) ?? undefined;
  }

  for (const workspaceDir of params.context.workspaceDirs) {
    try {
      const registry = loadOpenClawPlugins({
        config: params.context.configForWorkspaceResolution,
        workspaceDir,
        activate: false,
        cache: false,
        onlyPluginIds: resolveScopedPluginIdsForChannelSnapshot({
          context: params.context,
          workspaceDir,
          channel: normalized,
        }),
        includeSetupOnlyChannelPlugins: true,
        preferSetupRuntimeForChannelPlugins: true,
        runtimeOptions: {
          allowGatewaySubagentBinding: true,
        },
      });
      const plugin = findChannelPlugin({
        registry,
        channel: normalized,
      });
      if (resolveChannelConfiguredBindingProvider(plugin)) {
        params.context.channelPluginCache.set(normalized, plugin ?? null);
        return plugin;
      }
    } catch {
      continue;
    }
  }

  params.context.channelPluginCache.set(normalized, null);
  return undefined;
}

function resolveConfiguredBindingChannelPlugin(params: {
  context: ConfiguredBindingCompilerContext;
  channel: string;
}) {
  const normalized = params.channel.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }

  const current = resolveLoadedChannelPlugin(normalized);
  if (current) {
    return current;
  }

  return resolveConfiguredBindingChannelPluginSnapshot({
    context: params.context,
    channel: normalized,
  });
}

function resolveConfiguredBindingAdapter(params: {
  context: ConfiguredBindingCompilerContext;
  channel: string;
}): { channel: ConfiguredBindingChannel; provider: ChannelConfiguredBindingProvider } | null {
  const normalized = params.channel.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  const plugin = resolveConfiguredBindingChannelPlugin({
    context: params.context,
    channel: normalized,
  });
  const provider = resolveChannelConfiguredBindingProvider(plugin);
  if (
    !plugin ||
    !provider ||
    !(provider.compileConfiguredBinding || provider.normalizeConfiguredBindingTarget) ||
    !(provider.matchInboundConversation || provider.matchConfiguredBinding)
  ) {
    return null;
  }
  return {
    channel: plugin.id,
    provider,
  };
}

function resolveAccountMatchPriority(match: string | undefined, actual: string): 0 | 1 | 2 {
  const trimmed = (match ?? "").trim();
  if (!trimmed) {
    return actual === DEFAULT_ACCOUNT_ID ? 2 : 0;
  }
  if (trimmed === "*") {
    return 1;
  }
  return normalizeAccountId(trimmed) === actual ? 2 : 0;
}

function resolveBindingConversationId(binding: {
  match?: { peer?: { id?: string } };
}): string | null {
  const id = binding.match?.peer?.id?.trim();
  return id ? id : null;
}

function compileConfiguredBindingTarget(params: {
  provider: ChannelConfiguredBindingProvider;
  binding: CompiledConfiguredBinding["binding"];
  conversationId: string;
}): ChannelConfiguredBindingConversationRef | null {
  return (
    params.provider.compileConfiguredBinding?.({
      binding: params.binding,
      conversationId: params.conversationId,
    }) ??
    params.provider.normalizeConfiguredBindingTarget?.({
      binding: params.binding,
      conversationId: params.conversationId,
    }) ??
    null
  );
}

function matchCompiledBindingConversation(params: {
  rule: CompiledConfiguredBinding;
  conversationId: string;
  parentConversationId?: string;
}): ChannelConfiguredBindingMatch | null {
  return (
    params.rule.provider.matchInboundConversation?.({
      binding: params.rule.binding,
      compiledBinding: params.rule.target,
      conversationId: params.conversationId,
      parentConversationId: params.parentConversationId,
    }) ??
    params.rule.provider.matchConfiguredBinding?.({
      binding: params.rule.binding,
      bindingConversationId: params.rule.bindingConversationId,
      conversationId: params.conversationId,
      parentConversationId: params.parentConversationId,
    }) ??
    null
  );
}

function compileConfiguredBindingRule(params: {
  cfg: OpenClawConfig;
  channel: ConfiguredBindingChannel;
  binding: CompiledConfiguredBinding["binding"];
  target: ChannelConfiguredBindingConversationRef;
  bindingConversationId: string;
  provider: ChannelConfiguredBindingProvider;
}): CompiledConfiguredBinding | null {
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
    accountPattern: params.binding.match.accountId?.trim() || undefined,
    binding: params.binding,
    bindingConversationId: params.bindingConversationId,
    target: params.target,
    agentId,
    provider: params.provider,
    targetFactory,
  };
}

function pushCompiledRule(
  target: Map<ConfiguredBindingChannel, CompiledConfiguredBinding[]>,
  rule: CompiledConfiguredBinding,
) {
  const existing = target.get(rule.channel);
  if (existing) {
    existing.push(rule);
    return;
  }
  target.set(rule.channel, [rule]);
}

function compileConfiguredBindingRegistry(params: {
  cfg: OpenClawConfig;
  allowSnapshotFallback: boolean;
}): CompiledConfiguredBindingRegistry {
  const context = createConfiguredBindingCompilerContext(params.cfg, {
    allowSnapshotFallback: params.allowSnapshotFallback,
  });
  const rulesByChannel = new Map<ConfiguredBindingChannel, CompiledConfiguredBinding[]>();

  for (const binding of listConfiguredBindings(params.cfg)) {
    const bindingConversationId = resolveBindingConversationId(binding);
    if (!bindingConversationId) {
      continue;
    }

    const resolvedChannel = resolveConfiguredBindingAdapter({
      context,
      channel: binding.match.channel,
    });
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

function resolveCompiledBindingRegistry(cfg: OpenClawConfig): CompiledConfiguredBindingRegistry {
  const registryVersion = getActivePluginRegistryVersion();
  const cached = compiledRegistryCache.get(cfg);
  if (cached?.registryVersion === registryVersion) {
    return cached.registry;
  }

  const registry = compileConfiguredBindingRegistry({
    cfg,
    allowSnapshotFallback: false,
  });
  compiledRegistryCache.set(cfg, {
    registryVersion,
    registry,
  });
  return registry;
}

function resolveCompiledBindingChannel(raw: string): ConfiguredBindingChannel | null {
  const normalized = raw.trim().toLowerCase();
  return normalized ? (normalized as ConfiguredBindingChannel) : null;
}

function toConfiguredBindingConversationRef(conversation: ConversationRef): {
  channel: ConfiguredBindingChannel;
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
} | null {
  const channel = resolveCompiledBindingChannel(conversation.channel);
  const conversationId = conversation.conversationId.trim();
  if (!channel || !conversationId) {
    return null;
  }
  return {
    channel,
    accountId: normalizeAccountId(conversation.accountId),
    conversationId,
    parentConversationId: conversation.parentConversationId?.trim() || undefined,
  };
}

function materializeConfiguredBindingRecord(params: {
  rule: CompiledConfiguredBinding;
  accountId: string;
  conversation: ChannelConfiguredBindingConversationRef;
}): ConfiguredBindingRecordResolution {
  return params.rule.targetFactory.materialize({
    accountId: normalizeAccountId(params.accountId),
    conversation: params.conversation,
  });
}

function resolveMatchingConfiguredBinding(params: {
  rules: CompiledConfiguredBinding[];
  conversation: ReturnType<typeof toConfiguredBindingConversationRef>;
}): { rule: CompiledConfiguredBinding; match: ChannelConfiguredBindingMatch } | null {
  if (!params.conversation) {
    return null;
  }

  let wildcardMatch: {
    rule: CompiledConfiguredBinding;
    match: ChannelConfiguredBindingMatch;
  } | null = null;
  let exactMatch: { rule: CompiledConfiguredBinding; match: ChannelConfiguredBindingMatch } | null =
    null;

  for (const rule of params.rules) {
    const accountMatchPriority = resolveAccountMatchPriority(
      rule.accountPattern,
      params.conversation.accountId,
    );
    if (accountMatchPriority === 0) {
      continue;
    }
    const match = matchCompiledBindingConversation({
      rule,
      conversationId: params.conversation.conversationId,
      parentConversationId: params.conversation.parentConversationId,
    });
    if (!match) {
      continue;
    }
    const matchPriority = match.matchPriority ?? 0;
    if (accountMatchPriority === 2) {
      if (!exactMatch || matchPriority > (exactMatch.match.matchPriority ?? 0)) {
        exactMatch = { rule, match };
      }
      continue;
    }
    if (!wildcardMatch || matchPriority > (wildcardMatch.match.matchPriority ?? 0)) {
      wildcardMatch = { rule, match };
    }
  }

  return exactMatch ?? wildcardMatch;
}

export function primeConfiguredBindingRegistry(params: { cfg: OpenClawConfig }): {
  bindingCount: number;
  channelCount: number;
} {
  const registry = compileConfiguredBindingRegistry({
    cfg: params.cfg,
    allowSnapshotFallback: true,
  });
  compiledRegistryCache.set(params.cfg, {
    registryVersion: getActivePluginRegistryVersion(),
    registry,
  });
  return {
    bindingCount: [...registry.rulesByChannel.values()].reduce(
      (sum, rules) => sum + rules.length,
      0,
    ),
    channelCount: registry.rulesByChannel.size,
  };
}

export function resolveConfiguredBindingRecord(params: {
  cfg: OpenClawConfig;
  channel: string;
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
}): ConfiguredBindingRecordResolution | null {
  const conversation = toConfiguredBindingConversationRef({
    channel: params.channel,
    accountId: params.accountId,
    conversationId: params.conversationId,
    parentConversationId: params.parentConversationId,
  });
  if (!conversation) {
    return null;
  }
  return resolveConfiguredBindingRecordForConversation({
    cfg: params.cfg,
    conversation,
  });
}

export function resolveConfiguredBindingRecordForConversation(params: {
  cfg: OpenClawConfig;
  conversation: ConversationRef;
}): ConfiguredBindingRecordResolution | null {
  const conversation = toConfiguredBindingConversationRef(params.conversation);
  if (!conversation) {
    return null;
  }
  const registry = resolveCompiledBindingRegistry(params.cfg);
  const rules = registry.rulesByChannel.get(conversation.channel);
  if (!rules || rules.length === 0) {
    return null;
  }
  const resolved = resolveMatchingConfiguredBinding({
    rules,
    conversation,
  });
  if (!resolved) {
    return null;
  }
  return materializeConfiguredBindingRecord({
    rule: resolved.rule,
    accountId: conversation.accountId,
    conversation: resolved.match,
  });
}

export function resolveConfiguredBinding(params: {
  cfg: OpenClawConfig;
  conversation: ConversationRef;
}): ConfiguredBindingResolution | null {
  const conversation = toConfiguredBindingConversationRef(params.conversation);
  if (!conversation) {
    return null;
  }
  const registry = resolveCompiledBindingRegistry(params.cfg);
  const rules = registry.rulesByChannel.get(conversation.channel);
  if (!rules || rules.length === 0) {
    return null;
  }
  const resolved = resolveMatchingConfiguredBinding({
    rules,
    conversation,
  });
  if (!resolved) {
    return null;
  }
  const materializedTarget = materializeConfiguredBindingRecord({
    rule: resolved.rule,
    accountId: conversation.accountId,
    conversation: resolved.match,
  });
  return {
    conversation,
    compiledBinding: resolved.rule,
    match: resolved.match,
    ...materializedTarget,
  };
}

export function resolveConfiguredBindingRecordBySessionKey(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
}): ConfiguredBindingRecordResolution | null {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    return null;
  }

  const registry = resolveCompiledBindingRegistry(params.cfg);
  for (const consumer of listConfiguredBindingConsumers()) {
    const parsed = consumer.parseSessionKey?.({ sessionKey });
    if (!parsed) {
      continue;
    }
    const channel = resolveCompiledBindingChannel(parsed.channel);
    if (!channel) {
      continue;
    }
    const rules = registry.rulesByChannel.get(channel);
    if (!rules || rules.length === 0) {
      continue;
    }
    let wildcardMatch: ConfiguredBindingRecordResolution | null = null;
    let exactMatch: ConfiguredBindingRecordResolution | null = null;
    for (const rule of rules) {
      if (rule.targetFactory.driverId !== consumer.id) {
        continue;
      }
      const accountMatchPriority = resolveAccountMatchPriority(
        rule.accountPattern,
        parsed.accountId,
      );
      if (accountMatchPriority === 0) {
        continue;
      }
      const materializedTarget = materializeConfiguredBindingRecord({
        rule,
        accountId: parsed.accountId,
        conversation: rule.target,
      });
      const matchesSessionKey =
        consumer.matchesSessionKey?.({
          sessionKey,
          compiledBinding: rule,
          accountId: parsed.accountId,
          materializedTarget,
        }) ?? materializedTarget.record.targetSessionKey === sessionKey;
      if (matchesSessionKey) {
        if (accountMatchPriority === 2) {
          exactMatch = materializedTarget;
          break;
        }
        wildcardMatch = materializedTarget;
      }
    }
    if (exactMatch) {
      return exactMatch;
    }
    if (wildcardMatch) {
      return wildcardMatch;
    }
  }

  return null;
}
