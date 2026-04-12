import type { resolveAgentConfig } from "../../agents/agent-scope.js";
import type { AgentDefaultsConfig } from "../../config/types.js";

type ResolvedAgentConfig = NonNullable<ReturnType<typeof resolveAgentConfig>>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function mergeNestedDefinedOverrides<T extends Record<string, unknown>>(
  base: T,
  overrides: Partial<T>,
): T {
  const next: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      continue;
    }
    const existing = next[key];
    next[key] =
      isPlainObject(existing) && isPlainObject(value)
        ? mergeNestedDefinedOverrides(existing, value)
        : value;
  }
  return next as T;
}

function extractCronAgentDefaultsOverride(agentConfigOverride?: ResolvedAgentConfig) {
  const {
    model: overrideModel,
    sandbox: _agentSandboxOverride,
    ...agentOverrideRest
  } = agentConfigOverride ?? {};
  return {
    overrideModel,
    definedOverrides: Object.fromEntries(
      Object.entries(agentOverrideRest).filter(([, value]) => value !== undefined),
    ) as Partial<AgentDefaultsConfig>,
  };
}

function mergeCronAgentModelOverride(params: {
  defaults: AgentDefaultsConfig;
  overrideModel: ResolvedAgentConfig["model"] | undefined;
}) {
  const nextDefaults: AgentDefaultsConfig = { ...params.defaults };
  const existingModel =
    nextDefaults.model && typeof nextDefaults.model === "object" ? nextDefaults.model : {};
  if (typeof params.overrideModel === "string") {
    nextDefaults.model = { ...existingModel, primary: params.overrideModel };
  } else if (params.overrideModel) {
    nextDefaults.model = { ...existingModel, ...params.overrideModel };
  }
  return nextDefaults;
}

export function buildCronAgentDefaultsConfig(params: {
  defaults?: AgentDefaultsConfig;
  agentConfigOverride?: ResolvedAgentConfig;
}) {
  const { overrideModel, definedOverrides } = extractCronAgentDefaultsOverride(
    params.agentConfigOverride,
  );
  // Keep sandbox overrides out of `agents.defaults` here. Sandbox resolution
  // already merges global defaults with per-agent overrides using `agentId`;
  // copying the agent sandbox into defaults clobbers global defaults and can
  // double-apply nested agent overrides during isolated cron runs.
  return mergeCronAgentModelOverride({
    defaults: mergeNestedDefinedOverrides(params.defaults ?? {}, definedOverrides),
    overrideModel,
  });
}
