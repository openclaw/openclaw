import { resolveAgentModelConfigForRuntime } from "../../agents/agent-scope-config.js";
/** Builds isolated cron runner config from global defaults plus agent overrides. */
import type { resolveAgentConfig } from "../../agents/agent-scope.js";
import { toAgentModelListLike } from "../../config/model-input.js";
import { selectLiveRuntimeConfig } from "../../config/runtime-snapshot.js";
import type { AgentDefaultsConfig } from "../../config/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

type ResolvedAgentConfig = NonNullable<ReturnType<typeof resolveAgentConfig>>;

/** Selects the active runtime snapshot, then derives isolated cron agent defaults from it. */
export function resolveCronAgentConfig(params: {
  config: OpenClawConfig;
  agentConfigOverride?: ResolvedAgentConfig;
}) {
  const runtimeConfig = selectLiveRuntimeConfig(params.config);
  const {
    model: _agentModelOverride,
    sandbox: _agentSandboxOverride,
    memory: _agentMemoryOverride,
    models: _agentModelsOverride,
    params: _agentParamsOverride,
    ...agentOverrideRest
  } = params.agentConfigOverride ?? {};
  const overrideModel = resolveAgentModelConfigForRuntime(params.agentConfigOverride);
  const definedOverrides = Object.fromEntries(
    Object.entries(agentOverrideRest).filter(([, value]) => value !== undefined),
  ) as Partial<AgentDefaultsConfig>;
  // Agent-aware resolvers merge these scopes themselves. Flattening partial maps
  // erases inherited sandbox, memory, model-runtime and request-parameter settings.
  const agentDefaults: AgentDefaultsConfig = {
    ...runtimeConfig.agents?.defaults,
    ...definedOverrides,
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
