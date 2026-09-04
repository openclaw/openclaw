// Outbound channel bootstrap lazily loads runtime plugins for selected channels
// when only setup-shell metadata is active.
import {
  resolveAgentWorkspaceDir,
  tryResolveAmbientOwnerAgentId,
} from "../../agents/agent-scope.js";
import { supportsChannelMessageAction } from "../../channels/plugins/helpers.js";
import type { ChannelMessageActionName } from "../../channels/plugins/types.public.js";
import { cloneEnvWithPlatformSemantics } from "../../config/config-env-vars.js";
import { applyPluginAutoEnable } from "../../config/plugin-auto-enable.js";
import { resolveRuntimeConfigCacheKey } from "../../config/runtime-snapshot.js";
import { resolveStateDir } from "../../config/state-dir.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withActivatedPluginIds } from "../../plugins/activation-context.js";
import { prepareBundledDiscoveryMode } from "../../plugins/bundled-discovery-state.js";
import { resolveDiscoverableScopedChannelPluginIds } from "../../plugins/channel-plugin-ids.js";
import { getCurrentPluginMetadataSnapshot } from "../../plugins/current-plugin-metadata-snapshot.js";
import { preparePersistedInstalledPluginIndexCacheEntry } from "../../plugins/installed-plugin-index-record-state.js";
import { loadPluginRegistryHandle } from "../../plugins/loader.js";
import {
  getPluginCache,
  getPluginCacheRetirementSignal,
  retainPluginCache,
  withPluginCache,
} from "../../plugins/plugin-cache.js";
import { PluginLruCache } from "../../plugins/plugin-lru-cache.js";
import { resolvePluginMetadataEnvFingerprint } from "../../plugins/plugin-metadata-env.js";
import { isPluginRegistryRetired } from "../../plugins/registry-lifecycle.js";
import type { PluginChannelRegistration } from "../../plugins/registry-types.js";
import type { PluginRegistry } from "../../plugins/registry.js";
import { getActivePluginRegistry, getActivePluginRegistryVersion } from "../../plugins/runtime.js";
import { getPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";

const MAX_BOOTSTRAP_CONFIG_GENERATIONS = 64;
const MAX_BOOTSTRAP_CHANNEL_OUTCOMES_PER_CONFIG = 64;
type BootstrapRegistries = PluginLruCache<PluginRegistry | null>;
let bootstrapRegistriesByScope = new WeakMap<
  object,
  { metadata: object; version: number; configs: PluginLruCache<BootstrapRegistries> }
>();

function resolveBootstrapRegistries(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): BootstrapRegistries | undefined {
  const cache = getPluginCache();
  if (getPluginCacheRetirementSignal(cache).aborted) {
    return undefined;
  }
  const metadata = cache.metadata;
  const version = getActivePluginRegistryVersion();
  // This only partitions outcomes; plugin selection and cold policy reads stay with their owners.
  const snapshot = getCurrentPluginMetadataSnapshot({
    env,
    allowScopedSnapshot: true,
    allowWorkspaceScopedSnapshot: true,
    allowSynchronousPolicyRead: false,
  });
  const scope = snapshot ?? metadata;
  let state = bootstrapRegistriesByScope.get(scope);
  if (!state || state.metadata !== metadata || state.version !== version) {
    state = { metadata, version, configs: new PluginLruCache(MAX_BOOTSTRAP_CONFIG_GENERATIONS) };
    bootstrapRegistriesByScope.set(scope, state);
  }
  const configKey = resolveRuntimeConfigCacheKey(cfg);
  const key = snapshot
    ? configKey
    : JSON.stringify([configKey, resolvePluginMetadataEnvFingerprint(env)]);
  let registries = state.configs.get(key);
  if (!registries) {
    registries = new PluginLruCache(MAX_BOOTSTRAP_CHANNEL_OUTCOMES_PER_CONFIG);
    state.configs.set(key, registries);
  }
  return registries;
}

/** Clears the per-generation channel bootstrap handle cache for isolated tests. */
export function resetOutboundChannelBootstrapStateForTests(): void {
  bootstrapRegistriesByScope = new WeakMap();
}

function channelEntryCanSend(
  entry: PluginChannelRegistration | undefined,
  requiredAction?: ChannelMessageActionName,
): boolean {
  if (entry?.plugin?.outbound?.sendText ?? entry?.plugin?.message?.send?.text) {
    return true;
  }
  return supportsChannelMessageAction(entry?.plugin?.actions, requiredAction);
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
  requiredAction?: ChannelMessageActionName,
): PluginRegistry | undefined {
  return registry && channelEntryCanSend(findChannelEntry(registry, channel), requiredAction)
    ? registry
    : undefined;
}

type OutboundChannelBootstrapParams = {
  channel: string;
  cfg?: OpenClawConfig;
  agentId?: string;
  requiredAction?: ChannelMessageActionName;
};

type OutboundChannelBootstrapPlan =
  | { kind: "resolved"; registry: PluginRegistry | undefined }
  | {
      kind: "cold";
      cfg: OpenClawConfig;
      agentId: string | undefined;
      outcomeKey: string;
      registries: BootstrapRegistries | undefined;
    };

function resolveBootstrapPlan(
  params: OutboundChannelBootstrapParams,
  env: NodeJS.ProcessEnv = process.env,
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
  const activeSendRegistry = resolveSendCapableRegistry(
    activeRegistry,
    params.channel,
    params.requiredAction,
  );
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
  const outcomeKey = `${agentId ?? ""}\0${params.channel}\0${params.requiredAction ?? ""}`;
  // Root-generation memoization cannot replace a selected scoped setup owner.
  // Its activation uses the loader's own registry-handle cache instead.
  const registries = scopedEntry ? undefined : resolveBootstrapRegistries(cfg, env);
  if (registries) {
    const cachedRegistry = registries.get(outcomeKey);
    if (
      cachedRegistry !== undefined &&
      (cachedRegistry === null || !isPluginRegistryRetired(cachedRegistry))
    ) {
      return {
        kind: "resolved",
        registry: resolveSendCapableRegistry(cachedRegistry, params.channel, params.requiredAction),
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
    sendRegistry = resolveSendCapableRegistry(registry, params.channel, params.requiredAction);
  } catch {
    // Best-effort bootstrap; the caller reports the unavailable channel.
  }
  registries?.set(outcomeKey, sendRegistry ?? null);
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
  const namespaceEnv = cloneEnvWithPlatformSemantics(process.env);
  const env = cloneEnvWithPlatformSemantics(namespaceEnv);
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
      const plan = resolveBootstrapPlan(params, namespaceEnv);
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
