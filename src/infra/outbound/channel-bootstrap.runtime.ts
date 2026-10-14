// Outbound channel bootstrap lazily loads runtime plugins for selected channels
// when only setup-shell metadata is active.
import {
  resolveAgentWorkspaceDir,
  tryResolveAmbientOwnerAgentId,
} from "../../agents/agent-scope.js";
import { cloneEnvWithPlatformSemantics } from "../../config/config-env-vars.js";
import { applyPluginAutoEnable } from "../../config/plugin-auto-enable.js";
import { resolveStateDir } from "../../config/state-dir.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withActivatedPluginIds } from "../../plugins/activation-context.js";
import { prepareBundledDiscoveryMode } from "../../plugins/bundled-discovery-state.js";
import { resolveDiscoverableScopedChannelPluginIds } from "../../plugins/channel-plugin-ids.js";
import { preparePersistedInstalledPluginIndexCacheEntry } from "../../plugins/installed-plugin-index-record-state.js";
import { loadPluginRegistryHandle } from "../../plugins/loader.js";
import { getPluginCache, withPluginCache } from "../../plugins/plugin-cache.js";
import type { PluginRegistry } from "../../plugins/registry.js";
import { getActivePluginRegistry } from "../../plugins/runtime.js";
import { getPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";

function resolveSendCapableRegistry(
  registry: PluginRegistry | null | undefined,
  channel: string,
): PluginRegistry | undefined {
  const entry = registry?.channels?.find((candidate) => candidate?.plugin?.id === channel);
  return registry && (entry?.plugin?.outbound?.sendText ?? entry?.plugin?.message?.send?.text)
    ? registry
    : undefined;
}

type OutboundChannelBootstrapParams = {
  channel: string;
  cfg?: OpenClawConfig;
  agentId?: string;
};

type OutboundChannelBootstrapPlan =
  | { kind: "resolved"; registry: PluginRegistry | undefined }
  | {
      kind: "cold";
      cfg: OpenClawConfig;
      agentId: string | undefined;
    };

function resolveBootstrapPlan(
  params: OutboundChannelBootstrapParams,
): OutboundChannelBootstrapPlan {
  const cfg = params.cfg;
  if (!cfg) {
    return { kind: "resolved", registry: undefined };
  }

  const scopedRegistry = getPluginRuntimeGatewayRequestScope()?.pluginRegistry;
  const scopedEntry = scopedRegistry?.channels?.find(
    (entry) => entry?.plugin?.id === params.channel,
  );
  const activeRegistry = scopedEntry ? scopedRegistry : getActivePluginRegistry();
  const activeSendRegistry = resolveSendCapableRegistry(activeRegistry, params.channel);
  if (activeSendRegistry) {
    return { kind: "resolved", registry: activeSendRegistry };
  }

  // Outbound callers already know the admitted run owner. Preserve it here so
  // explicit fleets do not fall back to forbidden ambient-agent selection.
  // Agent-less sends route through the configured ambient owner (systemAgent,
  // then the legacy default); ownerless fleets never throw — startup
  // delivery recovery runs this path — and bootstrap with global-scope
  // plugin discovery only.
  const agentId = tryResolveAmbientOwnerAgentId(cfg, params.agentId);
  return { kind: "cold", cfg, agentId };
}

function loadBootstrapPlan(
  channel: string,
  plan: Extract<OutboundChannelBootstrapPlan, { kind: "cold" }>,
  discovery?: { env: NodeJS.ProcessEnv; workspaceDir: string | undefined },
): PluginRegistry | undefined {
  const { cfg, agentId } = plan;
  const env = discovery?.env;
  const autoEnabled = applyPluginAutoEnable({ config: cfg, ...(env ? { env } : {}) });
  const workspaceDir = discovery
    ? discovery.workspaceDir
    : agentId === undefined
      ? undefined
      : resolveAgentWorkspaceDir(cfg, agentId);
  const pluginIds = resolveDiscoverableScopedChannelPluginIds({
    config: autoEnabled.config,
    activationSourceConfig: cfg,
    channelIds: [channel],
    workspaceDir,
    env: env ?? process.env,
  });
  const activatedConfig =
    withActivatedPluginIds({ config: autoEnabled.config, pluginIds }) ?? autoEnabled.config;
  const activatedSourceConfig = withActivatedPluginIds({ config: cfg, pluginIds }) ?? cfg;
  let sendRegistry: PluginRegistry | undefined;
  try {
    const registry = loadPluginRegistryHandle({
      config: activatedConfig,
      activationSourceConfig: activatedSourceConfig,
      autoEnabledReasons: autoEnabled.autoEnabledReasons,
      onlyPluginIds: pluginIds,
      workspaceDir,
      ...(env ? { env } : {}),
      runtimeOptions: {
        allowGatewaySubagentBinding: true,
      },
    });
    sendRegistry = resolveSendCapableRegistry(registry, channel);
  } catch {
    // Best-effort bootstrap; the caller reports the unavailable channel.
  }
  return sendRegistry;
}

/** Loads runtime plugins on demand when a selected outbound channel has only a setup shell. */
export function bootstrapOutboundChannelPlugin(
  params: OutboundChannelBootstrapParams,
): PluginRegistry | undefined {
  const plan = resolveBootstrapPlan(params);
  return plan.kind === "resolved" ? plan.registry : loadBootstrapPlan(params.channel, plan);
}

/** Prepares cold SQLite metadata before the shared bootstrap decision and loader. */
export async function bootstrapOutboundChannelPluginAsync(
  params: OutboundChannelBootstrapParams & { assertCurrent?: () => void },
): Promise<PluginRegistry | undefined> {
  params.assertCurrent?.();
  const initial = resolveBootstrapPlan(params);
  if (initial.kind === "resolved") {
    return initial.registry;
  }
  const cache = getPluginCache();
  const env = cloneEnvWithPlatformSemantics(process.env);
  // Preparation and synchronous derivation must keep the same physical state root across awaits.
  env.OPENCLAW_STATE_DIR = resolveStateDir(env);
  const discovery = {
    env,
    workspaceDir:
      initial.agentId === undefined
        ? undefined
        : resolveAgentWorkspaceDir(initial.cfg, initial.agentId, env),
  };
  return withPluginCache(cache, async () => {
    const activateDiscovery = await prepareBundledDiscoveryMode(env);
    await preparePersistedInstalledPluginIndexCacheEntry({ env });
    params.assertCurrent?.();
    activateDiscovery();
    return loadBootstrapPlan(params.channel, initial, discovery);
  });
}
