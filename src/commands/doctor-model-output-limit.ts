import { resolveMaxTokensParam } from "@openclaw/ai/transports";
import { findNormalizedProviderKey } from "@openclaw/model-catalog-core/provider-id";
import { resolveModelExtraParamSources } from "../agents/model-extra-params.js";
import { resolveDefaultModelForAgent } from "../agents/model-selection-config.js";
import { applyModelDefaults } from "../config/defaults.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadPluginManifestRegistryForPluginRegistry } from "../plugins/plugin-registry.js";
import { modelKey } from "../shared/model-key.js";

export type AgentModelOutputLimit = {
  /** Key under models.providers, as the operator wrote it. */
  providerKey: string;
  model: string;
  maxTokens: number;
  /** Config path of the setting that sets this limit. */
  path: string;
};

export type AgentModelOutputLimitParams = {
  cfg: OpenClawConfig;
  agentId: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

/**
 * Output token limit the agent's default model runs with when it is a configured
 * provider model: the lower of its ceiling (config defaults: 8192 unless the model,
 * provider, or catalog says otherwise) and any request budget from agent or model
 * params. Catalog-only models return undefined: their limit is not ours to judge.
 */
export function resolveAgentModelOutputLimit(
  params: AgentModelOutputLimitParams,
): AgentModelOutputLimit | undefined {
  const { cfg } = params;
  const ref = resolveDefaultModelForAgent({ cfg, agentId: params.agentId });
  const providerKey = findNormalizedProviderKey(cfg.models?.providers, ref.provider);
  if (!providerKey) {
    return undefined;
  }
  const sources = resolveModelExtraParamSources({
    config: cfg,
    provider: ref.provider,
    modelId: ref.model,
    agentId: params.agentId,
  });
  const key = JSON.stringify(modelKey(ref.provider, ref.model));
  const agentPath = `agents.entries.${params.agentId}`;
  // Same precedence as runtime request params: later sources win.
  let budget: Omit<AgentModelOutputLimit, "providerKey" | "model"> | undefined;
  for (const [source, path] of [
    [sources.defaultParams, "agents.defaults.params"],
    [sources.modelParams, `agents.defaults.models[${key}].params`],
    [sources.agentModelParams, `${agentPath}.models[${key}].params`],
    [sources.agentParams, `${agentPath}.params`],
  ] as const) {
    const maxTokens = resolveMaxTokensParam(source);
    if (maxTokens !== undefined) {
      budget = { maxTokens, path: `${path}.maxTokens` };
    }
  }
  const materialized = applyModelDefaults(cfg, {
    loadManifestRegistry: () =>
      loadPluginManifestRegistryForPluginRegistry({
        config: cfg,
        workspaceDir: params.cwd,
        env: params.env ?? process.env,
      }),
  });
  const index =
    materialized.models?.providers?.[providerKey]?.models?.findIndex(
      (model) => model.id === ref.model,
    ) ?? -1;
  const row = materialized.models?.providers?.[providerKey]?.models?.[index];
  // A limit authored on the row wins over the provider fallback, so point at the row.
  const rowAuthored = cfg.models?.providers?.[providerKey]?.models?.[index]?.maxTokens;
  const ceiling =
    typeof row?.maxTokens === "number"
      ? {
          maxTokens: row.maxTokens,
          path:
            rowAuthored === undefined
              ? `models.providers.${providerKey}.maxTokens`
              : `models.providers.${providerKey}.models[${index}].maxTokens`,
        }
      : undefined;
  // Transports clamp a larger request budget to the model ceiling; the lower one binds.
  const limit =
    budget && ceiling ? (budget.maxTokens < ceiling.maxTokens ? budget : ceiling) : ceiling;
  return limit ? { providerKey, model: ref.model, ...limit } : undefined;
}
