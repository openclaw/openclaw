import { resolveAgentModelConfigForRuntime } from "../../agents/agent-scope-config.js";
/** Builds isolated cron runner config from global defaults plus agent overrides. */
import type { resolveAgentConfig } from "../../agents/agent-scope.js";
import {
  getRuntimeConfigSnapshot,
  getRuntimeConfigSourceSnapshot,
  selectApplicableRuntimeConfig,
} from "../../config/config.js";
import { toAgentModelListLike } from "../../config/model-input.js";
import type { AgentDefaultsConfig } from "../../config/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

type ResolvedAgentConfig = NonNullable<ReturnType<typeof resolveAgentConfig>>;

/** Selects the active reloadable config when it descends from the cron caller's snapshot. */
export function resolveCronActiveRuntimeConfig(cfg: OpenClawConfig): OpenClawConfig {
  const runtimeConfig = getRuntimeConfigSnapshot();
  const runtimeSourceConfig = getRuntimeConfigSourceSnapshot();
  if (!runtimeConfig || !runtimeSourceConfig) {
    return cfg;
  }
  return (
    selectApplicableRuntimeConfig({ inputConfig: cfg, runtimeConfig, runtimeSourceConfig }) ?? cfg
  );
}

function extractCronAgentDefaultsOverride(agentConfigOverride?: ResolvedAgentConfig) {
  const {
    model: _agentModelOverride,
    sandbox: _agentSandboxOverride,
    memory: _agentMemoryOverride,
    models: _agentModelsOverride,
    params: _agentParamsOverride,
    ...agentOverrideRest
  } = agentConfigOverride ?? {};
  return {
    overrideModel: resolveAgentModelConfigForRuntime(agentConfigOverride),
    definedOverrides: Object.fromEntries(
      Object.entries(agentOverrideRest).filter(([, value]) => value !== undefined),
    ) as Partial<AgentDefaultsConfig>,
  };
}

/** Derives isolated cron agent defaults from one immutable config snapshot. */
export function resolveCronAgentConfigFromSnapshot(params: {
  config: OpenClawConfig;
  agentConfigOverride?: ResolvedAgentConfig;
}) {
  const runtimeConfig = params.config;
  const { overrideModel, definedOverrides } = extractCronAgentDefaultsOverride(
    params.agentConfigOverride,
  );
  // Agent-aware resolvers merge these scopes themselves. Flattening partial maps
  // erases inherited sandbox, memory, model-runtime and request-parameter settings.
  const agentDefaults: AgentDefaultsConfig = {
    ...Object.assign({}, runtimeConfig.agents?.defaults, definedOverrides),
  };
  const existingModel = toAgentModelListLike(agentDefaults.model) ?? {};
  if (typeof overrideModel === "string") {
    agentDefaults.model = { ...existingModel, primary: overrideModel };
  } else if (overrideModel) {
    agentDefaults.model = { ...existingModel, ...overrideModel };
  }
  return {
    runtimeConfig,
    agentDefaults,
    cfgWithAgentDefaults: {
      ...runtimeConfig,
      agents: Object.assign({}, runtimeConfig.agents, { defaults: agentDefaults }),
    } satisfies OpenClawConfig,
  };
}

/** Selects the active runtime snapshot before deriving isolated cron agent defaults. */
export function resolveCronAgentConfig(params: {
  config: OpenClawConfig;
  agentConfigOverride?: ResolvedAgentConfig;
}) {
  return resolveCronAgentConfigFromSnapshot({
    ...params,
    config: resolveCronActiveRuntimeConfig(params.config),
  });
}
