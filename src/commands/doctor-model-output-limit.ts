import { findNormalizedProviderKey } from "@openclaw/model-catalog-core/provider-id";
import { resolveDefaultModelForAgent } from "../agents/model-selection-config.js";
import { applyModelDefaults } from "../config/defaults.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadPluginManifestRegistryForPluginRegistry } from "../plugins/plugin-registry.js";

export type AgentModelOutputLimit = {
  /** Key under models.providers, as the operator wrote it. */
  providerKey: string;
  model: string;
  maxTokens: number;
};

export type AgentModelOutputLimitParams = {
  cfg: OpenClawConfig;
  agentId: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

/**
 * Output token limit the agent's default model runs with when it is a configured
 * provider model. Config defaults apply (8192 unless the model, provider, or catalog
 * says otherwise). Catalog-only models return undefined: their limit is not ours to judge.
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
  const materialized = applyModelDefaults(cfg, {
    loadManifestRegistry: () =>
      loadPluginManifestRegistryForPluginRegistry({
        config: cfg,
        workspaceDir: params.cwd,
        env: params.env ?? process.env,
      }),
  });
  const row = materialized.models?.providers?.[providerKey]?.models?.find(
    (model) => model.id === ref.model,
  );
  return typeof row?.maxTokens === "number"
    ? { providerKey, model: ref.model, maxTokens: row.maxTokens }
    : undefined;
}
