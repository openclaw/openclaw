import { buildConfiguredAcpSessionKey } from "../../acp/persistent-bindings.types.js";
import {
  normalizeBindingConfig,
  normalizeMode,
  normalizeText,
  toConfiguredAcpBindingRecord,
  type ConfiguredAcpBindingChannel,
  type ConfiguredAcpBindingSpec,
  type ResolvedConfiguredAcpBinding,
} from "../../acp/persistent-bindings.types.js";
import {
  resolveAgentConfig,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../../agents/agent-scope.js";
import { listAcpBindings } from "../../config/bindings.js";
import type { OpenClawConfig } from "../../config/config.js";
import { applyPluginAutoEnable } from "../../config/plugin-auto-enable.js";
import type { AgentAcpBinding } from "../../config/types.js";
import type { ConversationRef } from "../../infra/outbound/session-binding-service.js";
import { loadOpenClawPlugins } from "../../plugins/loader.js";
import { getActivePluginRegistry, getActivePluginRegistryVersion } from "../../plugins/runtime.js";
import { pickFirstExistingAgentId } from "../../routing/resolve-route.js";
import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  parseAgentSessionKey,
} from "../../routing/session-key.js";
import type { AcpBindingResolution, CompiledAcpBinding } from "./acp-binding-types.js";
import { getChannelPluginCatalogEntry } from "./catalog.js";
import { getChannelPlugin } from "./index.js";
import type {
  ChannelAcpBindingAdapter,
  ChannelAcpBindingConversationRef,
  ChannelAcpBindingMatch,
} from "./types.adapters.js";

type ChannelPluginLike = NonNullable<ReturnType<typeof getChannelPlugin>>;

type CompiledAcpBindingRegistry = {
  rulesByChannel: Map<ConfiguredAcpBindingChannel, CompiledAcpBinding[]>;
  exactSessionKeys: Map<string, CompiledAcpBinding>;
  wildcardRulesByChannel: Map<ConfiguredAcpBindingChannel, CompiledAcpBinding[]>;
};

type CachedCompiledAcpBindingRegistry = {
  registryVersion: number;
  registry: CompiledAcpBindingRegistry;
};

type ConfiguredBindingCompilerContext = {
  configForWorkspaceResolution: OpenClawConfig;
  workspaceDirs: string[];
  channelPluginCache: Map<string, ChannelPluginLike | null>;
  scopedPluginIdsCache: Map<string, string[]>;
};

const compiledRegistryCache = new WeakMap<OpenClawConfig, CachedCompiledAcpBindingRegistry>();

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

  const current = getChannelPlugin(normalized as ConfiguredAcpBindingChannel);
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
  for (const binding of listAcpBindings(autoEnabled)) {
    addWorkspaceDir(pickFirstExistingAgentId(autoEnabled, binding.agentId ?? "main"));
  }

  return {
    configForWorkspaceResolution: autoEnabled,
    workspaceDirs,
  };
}

function createConfiguredBindingCompilerContext(
  cfg: OpenClawConfig,
): ConfiguredBindingCompilerContext {
  const { configForWorkspaceResolution, workspaceDirs } =
    listConfiguredBindingCompilerWorkspaces(cfg);
  return {
    configForWorkspaceResolution,
    workspaceDirs,
    channelPluginCache: new Map(),
    scopedPluginIdsCache: new Map(),
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
      if (plugin?.acpBindings) {
        params.context.channelPluginCache.set(normalized, plugin);
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
}): { channel: ConfiguredAcpBindingChannel; adapter: ChannelAcpBindingAdapter } | null {
  const normalized = params.channel.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  const plugin = resolveConfiguredBindingChannelPlugin({
    context: params.context,
    channel: normalized,
  });
  const adapter = plugin?.acpBindings;
  if (
    !adapter ||
    !(adapter.compileConfiguredBinding || adapter.normalizeConfiguredBindingTarget) ||
    !(adapter.matchInboundConversation || adapter.matchConfiguredBinding)
  ) {
    return null;
  }
  return {
    channel: plugin.id,
    adapter,
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

function resolveExactAccountId(accountPattern: string | undefined): string | null {
  const trimmed = accountPattern?.trim() ?? "";
  if (!trimmed) {
    return DEFAULT_ACCOUNT_ID;
  }
  if (trimmed === "*") {
    return null;
  }
  return normalizeAccountId(trimmed);
}

function resolveBindingConversationId(binding: AgentAcpBinding): string | null {
  const id = binding.match.peer?.id?.trim();
  return id ? id : null;
}

function compileConfiguredBindingTarget(params: {
  adapter: ChannelAcpBindingAdapter;
  binding: AgentAcpBinding;
  conversationId: string;
}): ChannelAcpBindingConversationRef | null {
  return (
    params.adapter.compileConfiguredBinding?.({
      binding: params.binding,
      conversationId: params.conversationId,
    }) ??
    params.adapter.normalizeConfiguredBindingTarget?.({
      binding: params.binding,
      conversationId: params.conversationId,
    }) ??
    null
  );
}

function matchCompiledBindingConversation(params: {
  rule: CompiledAcpBinding;
  conversationId: string;
  parentConversationId?: string;
}): ChannelAcpBindingMatch | null {
  return (
    params.rule.adapter.matchInboundConversation?.({
      binding: params.rule.binding,
      compiledBinding: params.rule.target,
      conversationId: params.conversationId,
      parentConversationId: params.parentConversationId,
    }) ??
    params.rule.adapter.matchConfiguredBinding?.({
      binding: params.rule.binding,
      bindingConversationId: params.rule.bindingConversationId,
      conversationId: params.conversationId,
      parentConversationId: params.parentConversationId,
    }) ??
    null
  );
}

function resolveAgentRuntimeAcpDefaults(params: { cfg: OpenClawConfig; ownerAgentId: string }): {
  acpAgentId?: string;
  mode?: string;
  cwd?: string;
  backend?: string;
} {
  const agent = params.cfg.agents?.list?.find(
    (entry) => entry.id?.trim().toLowerCase() === params.ownerAgentId.toLowerCase(),
  );
  if (!agent || agent.runtime?.type !== "acp") {
    return {};
  }
  return {
    acpAgentId: normalizeText(agent.runtime.acp?.agent),
    mode: normalizeText(agent.runtime.acp?.mode),
    cwd: normalizeText(agent.runtime.acp?.cwd),
    backend: normalizeText(agent.runtime.acp?.backend),
  };
}

function resolveConfiguredBindingWorkspaceCwd(params: {
  cfg: OpenClawConfig;
  agentId: string;
}): string | undefined {
  const explicitAgentWorkspace = normalizeText(
    resolveAgentConfig(params.cfg, params.agentId)?.workspace,
  );
  if (explicitAgentWorkspace) {
    return resolveAgentWorkspaceDir(params.cfg, params.agentId);
  }
  if (params.agentId === resolveDefaultAgentId(params.cfg)) {
    const defaultWorkspace = normalizeText(params.cfg.agents?.defaults?.workspace);
    if (defaultWorkspace) {
      return resolveAgentWorkspaceDir(params.cfg, params.agentId);
    }
  }
  return undefined;
}

function compileConfiguredBindingRule(params: {
  cfg: OpenClawConfig;
  channel: ConfiguredAcpBindingChannel;
  binding: AgentAcpBinding;
  target: ChannelAcpBindingConversationRef;
  bindingConversationId: string;
  adapter: ChannelAcpBindingAdapter;
}): CompiledAcpBinding {
  const agentId = pickFirstExistingAgentId(params.cfg, params.binding.agentId ?? "main");
  const runtimeDefaults = resolveAgentRuntimeAcpDefaults({
    cfg: params.cfg,
    ownerAgentId: agentId,
  });
  const bindingOverrides = normalizeBindingConfig(params.binding.acp);
  const mode = normalizeMode(bindingOverrides.mode ?? runtimeDefaults.mode);
  return {
    channel: params.channel,
    accountPattern: normalizeText(params.binding.match.accountId),
    binding: params.binding,
    bindingConversationId: params.bindingConversationId,
    target: params.target,
    agentId,
    acpAgentId: normalizeText(runtimeDefaults.acpAgentId),
    mode,
    cwd:
      bindingOverrides.cwd ??
      runtimeDefaults.cwd ??
      resolveConfiguredBindingWorkspaceCwd({
        cfg: params.cfg,
        agentId,
      }),
    backend: bindingOverrides.backend ?? runtimeDefaults.backend,
    label: bindingOverrides.label,
    adapter: params.adapter,
  };
}

function materializeConfiguredBindingSpec(params: {
  rule: CompiledAcpBinding;
  accountId: string;
  conversation: ChannelAcpBindingConversationRef;
}): ConfiguredAcpBindingSpec {
  return {
    channel: params.rule.channel,
    accountId: normalizeAccountId(params.accountId),
    conversationId: params.conversation.conversationId,
    parentConversationId: params.conversation.parentConversationId,
    agentId: params.rule.agentId,
    acpAgentId: params.rule.acpAgentId,
    mode: params.rule.mode,
    cwd: params.rule.cwd,
    backend: params.rule.backend,
    label: params.rule.label,
  };
}

function pushCompiledRule(
  target: Map<ConfiguredAcpBindingChannel, CompiledAcpBinding[]>,
  rule: CompiledAcpBinding,
) {
  const existing = target.get(rule.channel);
  if (existing) {
    existing.push(rule);
    return;
  }
  target.set(rule.channel, [rule]);
}

function compileConfiguredAcpBindingRegistry(cfg: OpenClawConfig): CompiledAcpBindingRegistry {
  const context = createConfiguredBindingCompilerContext(cfg);
  const rulesByChannel = new Map<ConfiguredAcpBindingChannel, CompiledAcpBinding[]>();
  const exactSessionKeys = new Map<string, CompiledAcpBinding>();
  const wildcardRulesByChannel = new Map<ConfiguredAcpBindingChannel, CompiledAcpBinding[]>();

  for (const binding of listAcpBindings(cfg)) {
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
      adapter: resolvedChannel.adapter,
      binding,
      conversationId: bindingConversationId,
    });
    if (!target) {
      continue;
    }

    const rule = compileConfiguredBindingRule({
      cfg,
      channel: resolvedChannel.channel,
      binding,
      target,
      bindingConversationId,
      adapter: resolvedChannel.adapter,
    });
    pushCompiledRule(rulesByChannel, rule);

    const exactAccountId = resolveExactAccountId(rule.accountPattern);
    if (!exactAccountId) {
      pushCompiledRule(wildcardRulesByChannel, rule);
      continue;
    }

    const exactSpec = materializeConfiguredBindingSpec({
      rule,
      accountId: exactAccountId,
      conversation: rule.target,
    });
    const exactSessionKey = buildConfiguredAcpSessionKey(exactSpec);
    if (!exactSessionKeys.has(exactSessionKey)) {
      exactSessionKeys.set(exactSessionKey, rule);
    }
  }

  return {
    rulesByChannel,
    exactSessionKeys,
    wildcardRulesByChannel,
  };
}

function resolveCompiledAcpBindingRegistry(cfg: OpenClawConfig): CompiledAcpBindingRegistry {
  const registryVersion = getActivePluginRegistryVersion();
  const cached = compiledRegistryCache.get(cfg);
  if (cached?.registryVersion === registryVersion) {
    return cached.registry;
  }

  const registry = compileConfiguredAcpBindingRegistry(cfg);
  compiledRegistryCache.set(cfg, {
    registryVersion,
    registry,
  });
  return registry;
}

function resolveCompiledBindingChannel(raw: string): ConfiguredAcpBindingChannel | null {
  const normalized = raw.trim().toLowerCase();
  return normalized ? (normalized as ConfiguredAcpBindingChannel) : null;
}

function parseConfiguredBindingSessionKey(sessionKey: string): {
  channel: ConfiguredAcpBindingChannel;
  accountId: string;
} | null {
  const parsed = parseAgentSessionKey(sessionKey);
  const rest = parsed?.rest?.trim().toLowerCase() ?? "";
  if (!rest) {
    return null;
  }
  const tokens = rest.split(":");
  if (tokens.length !== 5 || tokens[0] !== "acp" || tokens[1] !== "binding") {
    return null;
  }
  const channel = resolveCompiledBindingChannel(tokens[2] ?? "");
  if (!channel) {
    return null;
  }
  return {
    channel,
    accountId: normalizeAccountId(tokens[3] ?? DEFAULT_ACCOUNT_ID),
  };
}

function resolveFromRule(params: {
  rule: CompiledAcpBinding;
  accountId: string;
  conversation: ChannelAcpBindingConversationRef;
}): ResolvedConfiguredAcpBinding {
  const spec = materializeConfiguredBindingSpec({
    rule: params.rule,
    accountId: params.accountId,
    conversation: params.conversation,
  });
  return {
    spec,
    record: toConfiguredAcpBindingRecord(spec),
  };
}

function toConfiguredBindingConversationRef(conversation: ConversationRef): {
  channel: ConfiguredAcpBindingChannel;
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

export function primeConfiguredAcpBindingRegistry(params: { cfg: OpenClawConfig }): {
  bindingCount: number;
  channelCount: number;
} {
  const registry = resolveCompiledAcpBindingRegistry(params.cfg);
  return {
    bindingCount: [...registry.rulesByChannel.values()].reduce(
      (sum, rules) => sum + rules.length,
      0,
    ),
    channelCount: registry.rulesByChannel.size,
  };
}

export function resolveConfiguredAcpBindingRecord(params: {
  cfg: OpenClawConfig;
  channel: string;
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
}): ResolvedConfiguredAcpBinding | null {
  const conversation = toConfiguredBindingConversationRef({
    channel: params.channel,
    accountId: params.accountId,
    conversationId: params.conversationId,
    parentConversationId: params.parentConversationId,
  });
  if (!conversation) {
    return null;
  }
  return resolveConfiguredAcpBindingRecordForConversation({
    cfg: params.cfg,
    conversation,
  });
}

export function resolveConfiguredAcpBindingRecordForConversation(params: {
  cfg: OpenClawConfig;
  conversation: ConversationRef;
}): ResolvedConfiguredAcpBinding | null {
  const conversation = toConfiguredBindingConversationRef(params.conversation);
  if (!conversation) {
    return null;
  }
  const registry = resolveCompiledAcpBindingRegistry(params.cfg);
  const rules = registry.rulesByChannel.get(conversation.channel);
  if (!rules || rules.length === 0) {
    return null;
  }

  let wildcardMatch: { rule: CompiledAcpBinding; match: ChannelAcpBindingMatch } | null = null;
  let exactMatch: { rule: CompiledAcpBinding; match: ChannelAcpBindingMatch } | null = null;

  for (const rule of rules) {
    const accountMatchPriority = resolveAccountMatchPriority(
      rule.accountPattern,
      conversation.accountId,
    );
    if (accountMatchPriority === 0) {
      continue;
    }
    const match = matchCompiledBindingConversation({
      rule,
      conversationId: conversation.conversationId,
      parentConversationId: conversation.parentConversationId,
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

  const resolved = exactMatch ?? wildcardMatch;
  if (!resolved) {
    return null;
  }
  return resolveFromRule({
    rule: resolved.rule,
    accountId: conversation.accountId,
    conversation: resolved.match,
  });
}

export function resolveConfiguredAcpBinding(params: {
  cfg: OpenClawConfig;
  conversation: ConversationRef;
}): AcpBindingResolution | null {
  const conversation = toConfiguredBindingConversationRef(params.conversation);
  if (!conversation) {
    return null;
  }
  const registry = resolveCompiledAcpBindingRegistry(params.cfg);
  const rules = registry.rulesByChannel.get(conversation.channel);
  if (!rules || rules.length === 0) {
    return null;
  }

  let wildcardMatch: { rule: CompiledAcpBinding; match: ChannelAcpBindingMatch } | null = null;
  let exactMatch: { rule: CompiledAcpBinding; match: ChannelAcpBindingMatch } | null = null;
  for (const rule of rules) {
    const accountMatchPriority = resolveAccountMatchPriority(
      rule.accountPattern,
      conversation.accountId,
    );
    if (accountMatchPriority === 0) {
      continue;
    }
    const match = matchCompiledBindingConversation({
      rule,
      conversationId: conversation.conversationId,
      parentConversationId: conversation.parentConversationId,
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

  const resolved = exactMatch ?? wildcardMatch;
  if (!resolved) {
    return null;
  }
  return {
    conversation,
    compiledBinding: resolved.rule,
    match: resolved.match,
    configuredBinding: resolveFromRule({
      rule: resolved.rule,
      accountId: conversation.accountId,
      conversation: resolved.match,
    }),
  };
}

export function resolveConfiguredAcpBindingSpecBySessionKey(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
}): ConfiguredAcpBindingSpec | null {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    return null;
  }
  const parsed = parseConfiguredBindingSessionKey(sessionKey);
  if (!parsed) {
    return null;
  }

  const registry = resolveCompiledAcpBindingRegistry(params.cfg);
  const exactRule = registry.exactSessionKeys.get(sessionKey);
  if (exactRule) {
    return materializeConfiguredBindingSpec({
      rule: exactRule,
      accountId: parsed.accountId,
      conversation: exactRule.target,
    });
  }

  const wildcardRules = registry.wildcardRulesByChannel.get(parsed.channel);
  if (!wildcardRules || wildcardRules.length === 0) {
    return null;
  }

  for (const rule of wildcardRules) {
    const spec = materializeConfiguredBindingSpec({
      rule,
      accountId: parsed.accountId,
      conversation: rule.target,
    });
    if (buildConfiguredAcpSessionKey(spec) === sessionKey) {
      return spec;
    }
  }

  return null;
}
