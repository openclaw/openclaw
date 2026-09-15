// Outbound channel bootstrap lazily loads runtime plugins for selected channels
// when only setup-shell metadata is active.
import {
  resolveAgentWorkspaceDir,
  tryResolveAmbientOwnerAgentId,
} from "../../agents/agent-scope.js";
import { cloneEnvWithPlatformSemantics } from "../../config/config-env-vars.js";
import { applyPluginAutoEnable } from "../../config/plugin-auto-enable.js";
import { resolveRuntimeConfigCacheKey } from "../../config/runtime-snapshot.js";
import { resolveStateDir } from "../../config/state-dir.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withActivatedPluginIds } from "../../plugins/activation-context.js";
import { prepareBundledDiscoveryMode } from "../../plugins/bundled-discovery-state.js";
import { resolveDiscoverableScopedChannelPluginIds } from "../../plugins/channel-plugin-ids.js";
import { preparePersistedInstalledPluginIndexCacheEntry } from "../../plugins/installed-plugin-index-record-state.js";
import { loadPluginRegistryHandle } from "../../plugins/loader.js";
import { getPluginCache, retainPluginCache, withPluginCache } from "../../plugins/plugin-cache.js";
import type { PluginChannelRegistration } from "../../plugins/registry-types.js";
import type { PluginRegistry } from "../../plugins/registry.js";
import { getActivePluginRegistry, getActivePluginRegistryVersion } from "../../plugins/runtime.js";
import { getPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { pruneMapToMaxSize } from "../map-size.js";

const MAX_BOOTSTRAP_CONFIG_GENERATIONS = 64;
const MAX_BOOTSTRAP_CHANNEL_OUTCOMES_PER_CONFIG = 64;
let bootstrapRegistryGeneration: string | undefined;
const bootstrapRegistriesByConfig = new Map<string, Map<string, PluginRegistry | null>>();

function cacheBootstrapOutcome(
  registries: Map<string, PluginRegistry | null>,
  key: string,
  outcome: PluginRegistry | null,
): void {
  // Reinsert every outcome, including null, so reads and writes share LRU ordering.
  registries.delete(key);
  registries.set(key, outcome);
  pruneMapToMaxSize(registries, MAX_BOOTSTRAP_CHANNEL_OUTCOMES_PER_CONFIG);
}

function resolveBootstrapRegistryGeneration(): string {
  return String(getActivePluginRegistryVersion());
}

function resolveBootstrapRegistries(cfg: OpenClawConfig): Map<string, PluginRegistry | null> {
  const registryGeneration = resolveBootstrapRegistryGeneration();
  if (registryGeneration !== bootstrapRegistryGeneration) {
    bootstrapRegistryGeneration = registryGeneration;
    bootstrapRegistriesByConfig.clear();
  }
  const configKey = resolveRuntimeConfigCacheKey(cfg);
  const existing = bootstrapRegistriesByConfig.get(configKey);
  if (existing) {
    bootstrapRegistriesByConfig.delete(configKey);
    bootstrapRegistriesByConfig.set(configKey, existing);
    return existing;
  }
  // Agent-scoped configs may interleave within one registry generation. Keep a
  // bounded LRU so one caller cannot evict another on every delivery attempt.
  pruneMapToMaxSize(bootstrapRegistriesByConfig, MAX_BOOTSTRAP_CONFIG_GENERATIONS - 1);
  const registries = new Map<string, PluginRegistry | null>();
  bootstrapRegistriesByConfig.set(configKey, registries);
  return registries;
}

/** Clears the per-generation channel bootstrap handle cache for isolated tests. */
export function resetOutboundChannelBootstrapStateForTests(): void {
  bootstrapRegistryGeneration = undefined;
  bootstrapRegistriesByConfig.clear();
}

function channelEntryCanSend(entry: PluginChannelRegistration | undefined): boolean {
  return Boolean(entry?.plugin?.outbound?.sendText ?? entry?.plugin?.message?.send?.text);
}

function findChannelEntry(
  registry: ReturnType<typeof getActivePluginRegistry>,
  channel: string,
): PluginChannelRegistration | undefined {
  return registry?.channels?.find((entry) => entry?.plugin?.id === channel);
}

function resolveSendCapableRegistry(
  registry: PluginRegistry | null | undefined,
  channel: string,
): PluginRegistry | undefined {
  return registry && channelEntryCanSend(findChannelEntry(registry, channel))
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
      outcomeKey: string;
      registries: Map<string, PluginRegistry | null> | undefined;
    };

function resolveBootstrapPlan(
  params: OutboundChannelBootstrapParams,
): OutboundChannelBootstrapPlan {
  const cfg = params.cfg;
  if (!cfg) {
    return { kind: "resolved", registry: undefined };
  }

  const scopedRegistry = getPluginRuntimeGatewayRequestScope()?.pluginRegistry;
  const scopedEntry = findChannelEntry(scopedRegistry ?? null, params.channel);
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
  // plugin discovery only. Normalized agent ids never equal "", so "" is a
  // collision-free ownerless cache slot.
  const agentId = tryResolveAmbientOwnerAgentId(cfg, params.agentId);
  const outcomeKey = `${agentId ?? ""}\0${params.channel}`;
  // Root-generation memoization cannot replace a selected scoped setup owner.
  // Its activation uses the loader's own registry-handle cache instead.
  const registries = scopedEntry ? undefined : resolveBootstrapRegistries(cfg);
  if (registries) {
    const cachedRegistry = registries.get(outcomeKey);
    if (cachedRegistry !== undefined) {
      cacheBootstrapOutcome(registries, outcomeKey, cachedRegistry);
      return {
        kind: "resolved",
        registry: resolveSendCapableRegistry(cachedRegistry, params.channel),
      };
    }
  }

  return { kind: "cold", cfg, agentId, outcomeKey, registries };
}

function loadBootstrapPlan(
  params: OutboundChannelBootstrapParams,
  plan: Extract<OutboundChannelBootstrapPlan, { kind: "cold" }>,
  discovery?: { env: NodeJS.ProcessEnv; workspaceDir: string | undefined },
): PluginRegistry | undefined {
  const { cfg, agentId, outcomeKey, registries } = plan;
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
    channelIds: [params.channel],
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
    sendRegistry = resolveSendCapableRegistry(registry, params.channel);
  } catch {
    // Best-effort bootstrap; the caller reports the unavailable channel.
  }
  if (registries) {
    cacheBootstrapOutcome(registries, outcomeKey, sendRegistry ?? null);
  }
  return sendRegistry;
}

/** Loads runtime plugins on demand when a selected outbound channel has only a setup shell. */
export function bootstrapOutboundChannelPlugin(
  params: OutboundChannelBootstrapParams,
): PluginRegistry | undefined {
  const plan = resolveBootstrapPlan(params);
  return plan.kind === "resolved" ? plan.registry : loadBootstrapPlan(params, plan);
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
  const release = retainPluginCache(cache);
  try {
    return await withPluginCache(cache, async () => {
      const activateDiscovery = await prepareBundledDiscoveryMode(env);
      params.assertCurrent?.();
      const installed = await preparePersistedInstalledPluginIndexCacheEntry({ env });
      params.assertCurrent?.();
      installed.assertCurrent();
      activateDiscovery();
      // A newer registry or scoped registration may have resolved this channel while we awaited.
      const plan = resolveBootstrapPlan(params);
      if (plan.kind === "resolved") {
        return plan.registry;
      }
      if (plan.agentId !== initial.agentId) {
        throw new Error(
          "Outbound plugin owner changed during metadata preparation; retry the operation.",
        );
      }
      return loadBootstrapPlan(params, plan, discovery);
    });
  } finally {
    release();
  }
}
