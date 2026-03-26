import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { getChannelPlugin } from "../../channels/plugins/index.js";
import type { ChannelPlugin } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { applyPluginAutoEnable } from "../../config/plugin-auto-enable.js";
import { loadOpenClawPlugins } from "../../plugins/loader.js";
import { getActivePluginRegistry, getActivePluginRegistryKey } from "../../plugins/runtime.js";
import {
  isDeliverableMessageChannel,
  normalizeMessageChannel,
  type DeliverableMessageChannel,
} from "../../utils/message-channel.js";

const bootstrapAttempts = new Set<string>();

export function resetOutboundChannelResolutionStateForTest(): void {
  bootstrapAttempts.clear();
}

export function normalizeDeliverableOutboundChannel(
  raw?: string | null,
): DeliverableMessageChannel | undefined {
  const normalized = normalizeMessageChannel(raw);
  if (!normalized || !isDeliverableMessageChannel(normalized)) {
    return undefined;
  }
  return normalized;
}

function maybeBootstrapChannelPlugin(params: {
  channel: DeliverableMessageChannel;
  cfg?: OpenClawConfig;
}): void {
  const cfg = params.cfg;
  if (!cfg) {
    return;
  }

  const activeRegistry = getActivePluginRegistry();
  const activeHasRequestedChannel = activeRegistry?.channels?.some(
    (entry) => entry?.plugin?.id === params.channel,
  );
  if (activeHasRequestedChannel) {
    return;
  }

  const registryKey = getActivePluginRegistryKey() ?? "<none>";
  const attemptKey = `${registryKey}:${params.channel}`;
  if (bootstrapAttempts.has(attemptKey)) {
    return;
  }
  bootstrapAttempts.add(attemptKey);

  const autoEnabled = applyPluginAutoEnable({ config: cfg }).config;
  const defaultAgentId = resolveDefaultAgentId(autoEnabled);
  const workspaceDir = resolveAgentWorkspaceDir(autoEnabled, defaultAgentId);
  try {
    loadOpenClawPlugins({
      config: autoEnabled,
      workspaceDir,
      runtimeOptions: {
        allowGatewaySubagentBinding: true,
      },
    });
  } catch {
    // Allow a follow-up resolution attempt if bootstrap failed transiently.
    bootstrapAttempts.delete(attemptKey);
  }
}

function resolveDirectFromActiveRegistry(
  channel: DeliverableMessageChannel,
): ChannelPlugin | undefined {
  const activeRegistry = getActivePluginRegistry();
  if (!activeRegistry) {
    return undefined;
  }
  for (const entry of activeRegistry.channels) {
    const plugin = entry?.plugin;
    if (plugin?.id === channel) {
      return plugin;
    }
  }
  return undefined;
}

export function resolveOutboundChannelPlugin(params: {
  channel: string;
  cfg?: OpenClawConfig;
}): ChannelPlugin | undefined {
  const normalized = normalizeDeliverableOutboundChannel(params.channel);
  if (!normalized) {
    return undefined;
  }

  const resolve = () => getChannelPlugin(normalized);
  const current = resolve();
  if (current) {
    return current;
  }
  const directCurrent = resolveDirectFromActiveRegistry(normalized);
  if (directCurrent) {
    return directCurrent;
  }

  maybeBootstrapChannelPlugin({ channel: normalized, cfg: params.cfg });
  return resolve() ?? resolveDirectFromActiveRegistry(normalized);
}
