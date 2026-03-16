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
import { loadOpenClawPlugins } from "../../plugins/loader.js";
import { getActivePluginRegistry, getActivePluginRegistryKey } from "../../plugins/runtime.js";
import { pickFirstExistingAgentId } from "../../routing/resolve-route.js";
import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  parseAgentSessionKey,
} from "../../routing/session-key.js";
import { getChannelPlugin } from "./index.js";

const bootstrapAttempts = new Set<string>();

function resolveLoadedChannelPlugin(channel: string) {
  const normalized = channel.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }

  const current = getChannelPlugin(normalized as ConfiguredAcpBindingChannel);
  if (current) {
    return current;
  }

  const activeRegistry = getActivePluginRegistry();
  if (!activeRegistry) {
    return undefined;
  }
  return activeRegistry.channels.find((entry) => entry?.plugin?.id === normalized)?.plugin;
}

function maybeBootstrapConfiguredBindingChannelPlugin(params: {
  cfg: OpenClawConfig;
  channel: string;
}): void {
  if (resolveLoadedChannelPlugin(params.channel)) {
    return;
  }

  const registryKey = getActivePluginRegistryKey() ?? "<none>";
  const attemptKey = `${registryKey}:${params.channel.trim().toLowerCase()}`;
  if (bootstrapAttempts.has(attemptKey)) {
    return;
  }
  bootstrapAttempts.add(attemptKey);

  const autoEnabled = applyPluginAutoEnable({ config: params.cfg }).config;
  const defaultAgentId = resolveDefaultAgentId(autoEnabled);
  const workspaceDir = resolveAgentWorkspaceDir(autoEnabled, defaultAgentId);
  try {
    loadOpenClawPlugins({
      config: autoEnabled,
      workspaceDir,
    });
  } catch {
    bootstrapAttempts.delete(attemptKey);
  }
}

function resolveConfiguredBindingChannelPlugin(params: { cfg: OpenClawConfig; channel: string }) {
  const normalized = params.channel.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }

  const current = resolveLoadedChannelPlugin(normalized);
  if (current) {
    return current;
  }

  maybeBootstrapConfiguredBindingChannelPlugin({
    cfg: params.cfg,
    channel: normalized,
  });
  return resolveLoadedChannelPlugin(normalized);
}

function normalizeBindingChannel(params: {
  cfg: OpenClawConfig;
  value: string | undefined;
}): ConfiguredAcpBindingChannel | null {
  const normalized = (params.value ?? "").trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  const plugin = resolveConfiguredBindingChannelPlugin({
    cfg: params.cfg,
    channel: normalized,
  });
  return plugin?.acpBindings ? plugin.id : null;
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

function resolveBindingConversationId(binding: AgentAcpBinding): string | null {
  const id = binding.match.peer?.id?.trim();
  return id ? id : null;
}

function parseConfiguredBindingSessionKey(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
}): { channel: ConfiguredAcpBindingChannel; accountId: string } | null {
  const parsed = parseAgentSessionKey(params.sessionKey);
  const rest = parsed?.rest?.trim().toLowerCase() ?? "";
  if (!rest) {
    return null;
  }
  const tokens = rest.split(":");
  if (tokens.length !== 5 || tokens[0] !== "acp" || tokens[1] !== "binding") {
    return null;
  }
  const channel = normalizeBindingChannel({
    cfg: params.cfg,
    value: tokens[2],
  });
  if (!channel) {
    return null;
  }
  return {
    channel,
    accountId: normalizeAccountId(tokens[3]),
  };
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

function toConfiguredBindingSpec(params: {
  cfg: OpenClawConfig;
  channel: ConfiguredAcpBindingChannel;
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
  binding: AgentAcpBinding;
}): ConfiguredAcpBindingSpec {
  const accountId = normalizeAccountId(params.accountId);
  const agentId = pickFirstExistingAgentId(params.cfg, params.binding.agentId ?? "main");
  const runtimeDefaults = resolveAgentRuntimeAcpDefaults({
    cfg: params.cfg,
    ownerAgentId: agentId,
  });
  const bindingOverrides = normalizeBindingConfig(params.binding.acp);
  const acpAgentId = normalizeText(runtimeDefaults.acpAgentId);
  const mode = normalizeMode(bindingOverrides.mode ?? runtimeDefaults.mode);
  return {
    channel: params.channel,
    accountId,
    conversationId: params.conversationId,
    parentConversationId: params.parentConversationId,
    agentId,
    acpAgentId,
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
  };
}

function resolveConfiguredBindingRecord(params: {
  cfg: OpenClawConfig;
  bindings: AgentAcpBinding[];
  channel: ConfiguredAcpBindingChannel;
  accountId: string;
  selectConversation: (binding: AgentAcpBinding) => {
    conversationId: string;
    parentConversationId?: string;
    matchPriority?: number;
  } | null;
}): ResolvedConfiguredAcpBinding | null {
  let wildcardMatch: {
    binding: AgentAcpBinding;
    conversationId: string;
    parentConversationId?: string;
    matchPriority: number;
  } | null = null;
  let exactMatch: {
    binding: AgentAcpBinding;
    conversationId: string;
    parentConversationId?: string;
    matchPriority: number;
  } | null = null;
  for (const binding of params.bindings) {
    if (
      normalizeBindingChannel({
        cfg: params.cfg,
        value: binding.match.channel,
      }) !== params.channel
    ) {
      continue;
    }
    const accountMatchPriority = resolveAccountMatchPriority(
      binding.match.accountId,
      params.accountId,
    );
    if (accountMatchPriority === 0) {
      continue;
    }
    const conversation = params.selectConversation(binding);
    if (!conversation) {
      continue;
    }
    const matchPriority = conversation.matchPriority ?? 0;
    if (accountMatchPriority === 2) {
      if (!exactMatch || matchPriority > exactMatch.matchPriority) {
        exactMatch = {
          binding,
          conversationId: conversation.conversationId,
          parentConversationId: conversation.parentConversationId,
          matchPriority,
        };
      }
      continue;
    }
    if (!wildcardMatch || matchPriority > wildcardMatch.matchPriority) {
      wildcardMatch = {
        binding,
        conversationId: conversation.conversationId,
        parentConversationId: conversation.parentConversationId,
        matchPriority,
      };
    }
  }
  if (exactMatch) {
    const spec = toConfiguredBindingSpec({
      cfg: params.cfg,
      channel: params.channel,
      accountId: params.accountId,
      conversationId: exactMatch.conversationId,
      parentConversationId: exactMatch.parentConversationId,
      binding: exactMatch.binding,
    });
    return {
      spec,
      record: toConfiguredAcpBindingRecord(spec),
    };
  }
  if (!wildcardMatch) {
    return null;
  }
  const spec = toConfiguredBindingSpec({
    cfg: params.cfg,
    channel: params.channel,
    accountId: params.accountId,
    conversationId: wildcardMatch.conversationId,
    parentConversationId: wildcardMatch.parentConversationId,
    binding: wildcardMatch.binding,
  });
  return {
    spec,
    record: toConfiguredAcpBindingRecord(spec),
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
  const parsedSessionKey = parseConfiguredBindingSessionKey({
    cfg: params.cfg,
    sessionKey,
  });
  if (!parsedSessionKey) {
    return null;
  }
  const plugin = resolveConfiguredBindingChannelPlugin({
    cfg: params.cfg,
    channel: parsedSessionKey.channel,
  });
  const acpBindings = plugin?.acpBindings;
  if (!acpBindings?.normalizeConfiguredBindingTarget) {
    return null;
  }

  let wildcardMatch: ConfiguredAcpBindingSpec | null = null;
  for (const binding of listAcpBindings(params.cfg)) {
    const channel = normalizeBindingChannel({
      cfg: params.cfg,
      value: binding.match.channel,
    });
    if (!channel || channel !== parsedSessionKey.channel) {
      continue;
    }
    const accountMatchPriority = resolveAccountMatchPriority(
      binding.match.accountId,
      parsedSessionKey.accountId,
    );
    if (accountMatchPriority === 0) {
      continue;
    }
    const targetConversationId = resolveBindingConversationId(binding);
    if (!targetConversationId) {
      continue;
    }
    const target = acpBindings.normalizeConfiguredBindingTarget({
      binding,
      conversationId: targetConversationId,
    });
    if (!target) {
      continue;
    }
    const spec = toConfiguredBindingSpec({
      cfg: params.cfg,
      channel,
      accountId: parsedSessionKey.accountId,
      conversationId: target.conversationId,
      parentConversationId: target.parentConversationId,
      binding,
    });
    if (buildConfiguredAcpSessionKey(spec) !== sessionKey) {
      continue;
    }
    if (accountMatchPriority === 2) {
      return spec;
    }
    if (!wildcardMatch) {
      wildcardMatch = spec;
    }
  }
  return wildcardMatch;
}

export function resolveConfiguredAcpBindingRecord(params: {
  cfg: OpenClawConfig;
  channel: string;
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
}): ResolvedConfiguredAcpBinding | null {
  const channel = normalizeBindingChannel({
    cfg: params.cfg,
    value: params.channel,
  });
  const accountId = normalizeAccountId(params.accountId);
  const conversationId = params.conversationId.trim();
  const parentConversationId = params.parentConversationId?.trim() || undefined;
  if (!channel || !conversationId) {
    return null;
  }
  const plugin = resolveConfiguredBindingChannelPlugin({
    cfg: params.cfg,
    channel,
  });
  const acpBindings = plugin?.acpBindings;
  if (!acpBindings?.matchConfiguredBinding) {
    return null;
  }
  const matchConfiguredBinding = acpBindings.matchConfiguredBinding;

  return resolveConfiguredBindingRecord({
    cfg: params.cfg,
    bindings: listAcpBindings(params.cfg),
    channel,
    accountId,
    selectConversation: (binding) => {
      const bindingConversationId = resolveBindingConversationId(binding);
      if (!bindingConversationId) {
        return null;
      }
      return matchConfiguredBinding({
        binding,
        bindingConversationId,
        conversationId,
        parentConversationId,
      });
    },
  });
}
