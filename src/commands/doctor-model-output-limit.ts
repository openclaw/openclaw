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
  let manifestRegistry: ReturnType<typeof loadPluginManifestRegistryForPluginRegistry> | undefined;
  const loadManifestRegistry = () =>
    (manifestRegistry ??= loadPluginManifestRegistryForPluginRegistry({
      config: cfg,
      workspaceDir: params.cwd,
      env: params.env ?? process.env,
    }));
  const materializedRows = (config: OpenClawConfig) =>
    applyModelDefaults(config, { loadManifestRegistry }).models?.providers?.[providerKey]?.models;
  const provider = cfg.models?.providers?.[providerKey];
  // Materialized ids are normalized like the resolved ref (aliases such as `-latest`
  // collapse), and materialization keeps row order, so the index maps back to the
  // authored row for its remediation path.
  const rows = materializedRows(cfg);
  const index = rows?.findIndex((model) => model.id === ref.model) ?? -1;
  const row = rows?.[index];
  // A row-level maxTokens wins over the catalog and the provider fallback. Without one,
  // probe whether a higher provider maxTokens would raise the ceiling: only then is the
  // provider setting the one to change (the catalog limit can equal it by coincidence).
  let fromProvider = false;
  if (provider && provider.models?.[index]?.maxTokens === undefined && row?.maxTokens) {
    const probe = materializedRows({
      ...cfg,
      models: {
        ...cfg.models,
        providers: {
          ...cfg.models?.providers,
          [providerKey]: { ...provider, maxTokens: row.maxTokens * 2 },
        },
      },
    })?.[index];
    fromProvider = (probe?.maxTokens ?? 0) > row.maxTokens;
  }
  const ceiling =
    typeof row?.maxTokens === "number"
      ? {
          maxTokens: row.maxTokens,
          path: fromProvider
            ? `models.providers.${providerKey}.maxTokens`
            : `models.providers.${providerKey}.models[${index}].maxTokens`,
        }
      : undefined;
  // Transports clamp a larger request budget to the model ceiling; the lower one binds.
  const limit =
    budget && ceiling ? (budget.maxTokens < ceiling.maxTokens ? budget : ceiling) : ceiling;
  return limit ? { providerKey, model: ref.model, ...limit } : undefined;
}
