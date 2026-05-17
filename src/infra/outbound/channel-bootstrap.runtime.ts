import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { applyPluginAutoEnable } from "../../config/plugin-auto-enable.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveRuntimePluginRegistry } from "../../plugins/loader.js";
import {
  getActivePluginRegistry,
  getActivePluginChannelRegistry,
  getActivePluginChannelRegistryVersion,
  pinActivePluginChannelRegistry,
} from "../../plugins/runtime.js";
import type { DeliverableMessageChannel } from "../../utils/message-channel.js";

const bootstrapAttempts = new Set<string>();

function hasUsableOutboundChannel(
  registry:
    | ReturnType<typeof getActivePluginRegistry>
    | ReturnType<typeof getActivePluginChannelRegistry>,
  channel: DeliverableMessageChannel,
): boolean {
  return Boolean(
    registry?.channels?.some(
      (entry) =>
        entry?.plugin?.id === channel && typeof entry?.plugin?.outbound?.sendText === "function",
    ),
  );
}

function repinFromActiveRuntimeIfAvailable(channel: DeliverableMessageChannel): boolean {
  const activeRegistry = getActivePluginRegistry();
  if (!activeRegistry || !hasUsableOutboundChannel(activeRegistry, channel)) {
    return false;
  }
  pinActivePluginChannelRegistry(activeRegistry);
  return true;
}
export function resetOutboundChannelBootstrapStateForTests(): void {
  // Runtime channel plugins are loaded during Gateway startup now.
}

export function bootstrapOutboundChannelPlugin(params: {
  channel: DeliverableMessageChannel;
  cfg?: OpenClawConfig;
}): void {
  const cfg = params.cfg;
  if (!cfg) {
    return;
  }

  const activeChannelRegistry = getActivePluginChannelRegistry();
  if (hasUsableOutboundChannel(activeChannelRegistry, params.channel)) {
    return;
  }
  if (repinFromActiveRuntimeIfAvailable(params.channel)) {
    return;
  }

  const attemptKey = `${getActivePluginChannelRegistryVersion()}:${params.channel}`;
  if (bootstrapAttempts.has(attemptKey)) {
    return;
  }
  bootstrapAttempts.add(attemptKey);

  const autoEnabled = applyPluginAutoEnable({ config: cfg });
  const defaultAgentId = resolveDefaultAgentId(autoEnabled.config);
  const workspaceDir = resolveAgentWorkspaceDir(autoEnabled.config, defaultAgentId);
  try {
    resolveRuntimePluginRegistry({
      config: autoEnabled.config,
      activationSourceConfig: cfg,
      autoEnabledReasons: autoEnabled.autoEnabledReasons,
      workspaceDir,
      runtimeOptions: {
        allowGatewaySubagentBinding: true,
      },
    });
    repinFromActiveRuntimeIfAvailable(params.channel);
  } catch {
    bootstrapAttempts.delete(attemptKey);
  }
}
