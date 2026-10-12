import { parseProviderModelRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import { findNormalizedProviderKey } from "@openclaw/model-catalog-core/provider-id";
import { toAgentEntriesRecord } from "../agents/agent-scope-config.js";
import type { AuthProfileCredential } from "../agents/auth-profiles/types.js";
import { mergeAgentModelEntryForConfig } from "../config/model-input.js";
import { materializeModelPolicyAllowlist } from "../config/model-policy-allowlist-migration.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { materializeUtilityModelSeparation } from "../config/utility-model-separation-migration.js";
import { normalizeAgentId, normalizeAgentIdStrict } from "../routing/session-key.js";

type SystemAgentModelSelectionParams = {
  config: OpenClawConfig;
  /** Source before provider setup added its catalog or credential metadata. */
  previousConfig?: OpenClawConfig | null;
  model: string;
  modelTarget?: "utility";
  /** Write the model onto this configured agent instead of the default route. */
  targetAgentId?: string;
  agentRuntimeId?: string;
  /** First-run runtime metadata must not claim the pending agent roster. */
  runtimeInDefaults?: boolean;
  /** Pin the selected model to the exact credential that passed inference. */
  authProfileId?: string;
};

export async function createSystemAgentModelSelectionUpdater(
  params: Omit<SystemAgentModelSelectionParams, "config" | "previousConfig">,
): Promise<(config: OpenClawConfig, previousConfig?: OpenClawConfig | null) => OpenClawConfig> {
  const [agentScope, modelConfig, runtimePolicy] = await Promise.all([
    import("../agents/agent-scope.js"),
    import("../commands/models/shared.js"),
    import("../agents/model-runtime-policy.js"),
  ]);
  return (config, previousConfig = config) => {
    const selection = { ...params };
    let nextConfig = structuredClone(
      selection.modelTarget === "utility"
        ? materializeUtilityModelSeparation(config, previousConfig).config
        : config,
    );
    const normalizedTarget =
      selection.targetAgentId === undefined
        ? null
        : normalizeAgentIdStrict(selection.targetAgentId);
    if (normalizedTarget && !normalizedTarget.ok) {
      throw new Error(`Could not resolve configured agent "${selection.targetAgentId}".`);
    }
    const targetAgentId = normalizedTarget?.value;
    const agentId = agentScope.resolveAmbientOwnerAgentId(nextConfig, targetAgentId);
    const roster = agentScope.listAgentEntries(nextConfig);
    if (targetAgentId && !roster.some((entry) => normalizeAgentId(entry.id) === targetAgentId)) {
      throw new Error(`Could not resolve configured agent "${targetAgentId}".`);
    }
    // Explicit fleets keep utility selections on their agent; legacy default-route
    // selections stay global until that agent authors its own override.
    const writesAgent = Boolean(
      targetAgentId ||
      (selection.modelTarget === "utility"
        ? nextConfig.agents?.ownership === "explicit" ||
          agentScope.resolveAgentConfig(nextConfig, agentId)?.utilityModel !== undefined
        : agentScope.resolveAgentExplicitModelPrimary(nextConfig, agentId)),
    );
    const target = modelConfig.resolveModelTarget({ raw: selection.model, cfg: nextConfig });
    const key = modelConfig.upsertCanonicalModelConfigEntry({}, target);

    const configuredVisibleModels = nextConfig.agents?.defaults?.models;
    if (configuredVisibleModels && Object.keys(configuredVisibleModels).length > 0) {
      modelConfig.upsertCanonicalModelConfigEntry(configuredVisibleModels, target);
    }
    if (selection.runtimeInDefaults) {
      // Include the approved model in legacy restrictions before adding runtime-only metadata.
      nextConfig = materializeModelPolicyAllowlist(nextConfig).config;
    }
    nextConfig.agents ??= {};
    nextConfig.agents.defaults ??= {};
    const agentDefaults = nextConfig.agents.defaults;

    const agentEntries = toAgentEntriesRecord(roster);
    if (writesAgent || (selection.agentRuntimeId && !selection.runtimeInDefaults)) {
      nextConfig.agents = { ...nextConfig.agents, entries: agentEntries };
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

    if (selection.agentRuntimeId) {
      const runtimeTarget = selection.runtimeInDefaults
        ? agentDefaults
        : (agentEntries[agentEntryKey] ??= {});
      const agentModels = { ...runtimeTarget.models };
      const agentKey = modelConfig.upsertCanonicalModelConfigEntry(agentModels, target);
      agentModels[agentKey] = {
        ...agentModels[agentKey],
        agentRuntime: { id: selection.agentRuntimeId },
      };
      runtimeTarget.models = agentModels;
    } else if (selection.modelTarget !== "utility") {
      for (const owner of [agentDefaults, agent]) {
        if (owner?.models && Object.keys(owner.models).length > 0) {
          const models = { ...owner.models };
          const modelKey = modelConfig.upsertCanonicalModelConfigEntry(models, target);
          const entry = { ...models[modelKey] };
          delete entry.agentRuntime;
          models[modelKey] = entry;
          owner.models = models;
        }
      }
    }
    const selectedModel = selection.authProfileId ? `${key}@${selection.authProfileId}` : key;
    if (selection.modelTarget === "utility") {
      if (writesAgent && agent) {
        agent.utilityModel = selectedModel;
      } else {
        agentDefaults.utilityModel = selectedModel;
      }
    } else {
      agentScope.setAgentEffectiveModelPrimary(nextConfig, agentId, selectedModel, {
        forceAgent: Boolean(targetAgentId),
      });
    }
    if (selection.agentRuntimeId) {
      const effectiveRuntime = runtimePolicy.resolveModelRuntimePolicy({
        config: nextConfig,
        provider: target.provider,
        modelId: target.model,
        agentId,
      }).policy?.id;
      if (effectiveRuntime !== selection.agentRuntimeId) {
        throw new Error(`Could not pin ${key} to the ${selection.agentRuntimeId} runtime.`);
      }
    }
    return nextConfig;
  };
}

export async function applySystemAgentModelSelection(
  params: SystemAgentModelSelectionParams,
): Promise<OpenClawConfig> {
  const update = await createSystemAgentModelSelectionUpdater(params);
  return update(params.config, params.previousConfig);
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
