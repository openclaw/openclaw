import { parseProviderModelRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import { findNormalizedProviderKey } from "@openclaw/model-catalog-core/provider-id";
import { toAgentEntriesRecord } from "../agents/agent-scope-config.js";
import type { AuthProfileCredential } from "../agents/auth-profiles/types.js";
import { mergeAgentModelEntryForConfig } from "../config/model-input.js";
import { materializeModelPolicyAllowlist } from "../config/model-policy-allowlist-migration.js";
import type { AgentModelEntryConfig } from "../config/types.agent-defaults.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId, normalizeAgentIdStrict } from "../routing/session-key.js";

type SystemAgentModelSelectionParams = {
  config: OpenClawConfig;
  model: string;
  /** Write the model onto this configured agent instead of the default route. */
  targetAgentId?: string;
  agentRuntimeId?: string;
  /** First-run runtime metadata must not claim the pending agent roster. */
  runtimeInDefaults?: boolean;
  /** Pin the selected model to the exact credential that passed inference. */
  authProfileId?: string;
};

type SystemAgentModelSelectionModules = {
  agentScope: typeof import("../agents/agent-scope.js");
  modelConfig: typeof import("../commands/models/shared.js");
  runtimePolicy: typeof import("../agents/model-runtime-policy.js");
};

function applySystemAgentModelSelectionWithModules(
  params: SystemAgentModelSelectionParams,
  modules: SystemAgentModelSelectionModules,
): OpenClawConfig {
  const { agentScope, modelConfig, runtimePolicy } = modules;
  let nextConfig = structuredClone(params.config);
  const normalizedTarget =
    params.targetAgentId === undefined ? null : normalizeAgentIdStrict(params.targetAgentId);
  if (normalizedTarget && !normalizedTarget.ok) {
    throw new Error(`Could not resolve configured agent "${params.targetAgentId}".`);
  }
  const targetAgentId = normalizedTarget?.value;
  const agentId = agentScope.resolveAmbientOwnerAgentId(nextConfig, targetAgentId);
  const roster = agentScope.listAgentEntries(nextConfig);
  if (targetAgentId && !roster.some((entry) => normalizeAgentId(entry.id) === targetAgentId)) {
    throw new Error(`Could not resolve configured agent "${targetAgentId}".`);
  }
  // A targeted selection always lands on the agent entry; the default-route
  // selection only writes the agent when it already carries an explicit model.
  const writesAgent = Boolean(
    targetAgentId || agentScope.resolveAgentExplicitModelPrimary(nextConfig, agentId),
  );
  const target = modelConfig.resolveModelTarget({ raw: params.model, cfg: nextConfig });
  const key = modelConfig.upsertCanonicalModelConfigEntry({}, target);

  const configuredVisibleModels = nextConfig.agents?.defaults?.models;
  if (configuredVisibleModels && Object.keys(configuredVisibleModels).length > 0) {
    modelConfig.upsertCanonicalModelConfigEntry(configuredVisibleModels, target);
  }
  if (params.runtimeInDefaults) {
    // Include the approved model in legacy restrictions before adding runtime-only metadata.
    nextConfig = materializeModelPolicyAllowlist(nextConfig).config;
  }
  nextConfig.agents ??= {};
  nextConfig.agents.defaults ??= {};
  const agentDefaults = nextConfig.agents.defaults;

  const agentEntries = toAgentEntriesRecord(roster);
  if (writesAgent || (params.agentRuntimeId && !params.runtimeInDefaults)) {
    const { list: _legacyList, ...agentConfig } = nextConfig.agents;
    nextConfig.agents = { ...agentConfig, entries: agentEntries };
  }
  const agentEntryKey =
    roster.find((entry) => normalizeAgentId(entry.id) === agentId)?.id ?? agentId;
  const agent = agentEntries[agentEntryKey];
  if (writesAgent) {
    if (!agent) {
      throw new Error(`Could not resolve configured default agent "${agentId}".`);
    }
    const agentModels = { ...agent.models };
    agent.models = agentModels;
    modelConfig.upsertCanonicalModelConfigEntry(agentModels, target);
  }

  if (params.agentRuntimeId) {
    const runtimeTarget = params.runtimeInDefaults
      ? agentDefaults
      : (agentEntries[agentEntryKey] ??= { default: true });
    const agentModels = { ...runtimeTarget.models };
    const agentKey = modelConfig.upsertCanonicalModelConfigEntry(agentModels, target);
    agentModels[agentKey] = {
      ...agentModels[agentKey],
      agentRuntime: { id: params.agentRuntimeId },
    };
    runtimeTarget.models = agentModels;
  } else {
    const clearRuntimePin = (
      models: Record<string, AgentModelEntryConfig>,
    ): Record<string, AgentModelEntryConfig> => {
      const nextModels = { ...models };
      const modelKey = modelConfig.upsertCanonicalModelConfigEntry(nextModels, target);
      const entry = { ...nextModels[modelKey] };
      delete entry.agentRuntime;
      nextModels[modelKey] = entry;
      return nextModels;
    };
    const defaultModels = agentDefaults.models;
    if (defaultModels && Object.keys(defaultModels).length > 0) {
      agentDefaults.models = clearRuntimePin(defaultModels);
    }
    if (agent?.models && Object.keys(agent.models).length > 0) {
      agent.models = clearRuntimePin(agent.models);
    }
  }
  const selectedModel = params.authProfileId ? `${key}@${params.authProfileId}` : key;
  agentScope.setAgentEffectiveModelPrimary(nextConfig, agentId, selectedModel, {
    forceAgent: Boolean(targetAgentId),
  });
  if (params.agentRuntimeId) {
    const effectiveRuntime = runtimePolicy.resolveModelRuntimePolicy({
      config: nextConfig,
      provider: target.provider,
      modelId: target.model,
      agentId,
    }).policy?.id;
    if (effectiveRuntime !== params.agentRuntimeId) {
      throw new Error(`Could not pin ${key} to the ${params.agentRuntimeId} runtime.`);
    }
  }
  return nextConfig;
}

export async function createSystemAgentModelSelectionUpdater(
  params: Omit<SystemAgentModelSelectionParams, "config">,
): Promise<(config: OpenClawConfig) => OpenClawConfig> {
  const [agentScope, modelConfig, runtimePolicy] = await Promise.all([
    import("../agents/agent-scope.js"),
    import("../commands/models/shared.js"),
    import("../agents/model-runtime-policy.js"),
  ]);
  const modules = { agentScope, modelConfig, runtimePolicy };
  return (config) => applySystemAgentModelSelectionWithModules({ ...params, config }, modules);
}

export async function applySystemAgentModelSelection(
  params: SystemAgentModelSelectionParams,
): Promise<OpenClawConfig> {
  const update = await createSystemAgentModelSelectionUpdater(params);
  return update(params.config);
}

export function projectSetupInferenceConfig(params: {
  base: OpenClawConfig;
  prepared: OpenClawConfig;
  modelRef: string;
  sourceModelRef?: string;
  agentId: string;
  profileId?: string;
  credential?: AuthProfileCredential;
  pluginId?: string;
}): OpenClawConfig {
  const config = structuredClone(params.base);
  if (params.profileId) {
    const profile = params.prepared.auth?.profiles?.[params.profileId];
    if (profile) {
      config.auth = {
        ...config.auth,
        profiles: { ...config.auth?.profiles, [params.profileId]: structuredClone(profile) },
      };
    }
  }
  const provider = parseProviderModelRef(params.modelRef)?.provider ?? "";
  const providerKey = findNormalizedProviderKey(params.prepared.models?.providers, provider);
  const providerConfig = providerKey ? params.prepared.models?.providers?.[providerKey] : undefined;
  if (providerKey && providerConfig) {
    const selectedProvider = structuredClone(providerConfig);
    if (params.profileId) {
      delete selectedProvider.apiKey;
    }
    if (
      selectedProvider.headers?.["api-key"] &&
      params.credential?.type === "api_key" &&
      params.credential.keyRef
    ) {
      selectedProvider.headers["api-key"] = params.credential.keyRef;
    }
    config.models = {
      ...config.models,
      providers: { ...config.models?.providers, [providerKey]: selectedProvider },
    };
  }
  const plugin = params.pluginId ? params.prepared.plugins?.entries?.[params.pluginId] : undefined;
  if (params.pluginId && plugin) {
    config.plugins = {
      ...config.plugins,
      entries: { ...config.plugins?.entries, [params.pluginId]: structuredClone(plugin) },
    };
  }
  const modelKey = params.sourceModelRef ?? params.modelRef;
  const defaultModel = params.prepared.agents?.defaults?.models?.[modelKey];
  if (defaultModel) {
    const defaults = ((config.agents ??= {}).defaults ??= {});
    const models = (defaults.models ??= {});
    models[params.modelRef] = mergeAgentModelEntryForConfig(
      models[params.modelRef],
      structuredClone(defaultModel),
    );
  }
  const agentModel = params.prepared.agents?.entries?.[params.agentId]?.models?.[modelKey];
  if (agentModel) {
    const entries = ((config.agents ??= {}).entries ??= {});
    const models = ((entries[params.agentId] ??= {}).models ??= {});
    models[params.modelRef] = mergeAgentModelEntryForConfig(
      models[params.modelRef],
      structuredClone(agentModel),
    );
  }
  return config;
}
