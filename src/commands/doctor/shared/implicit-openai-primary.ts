import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  listAgentIds,
  resolveAgentDir,
  resolveAgentEffectiveModelPrimary,
} from "../../../agents/agent-scope.js";
import { loadAuthProfileStoreForSecretsRuntimeAsync } from "../../../agents/auth-profiles/store-runtime.js";
import { resolveConfiguredProviderFallback } from "../../../agents/configured-provider-fallback.js";
import { createModelAuthAvailabilityResolver } from "../../../agents/model-auth-availability.js";
import { resolveAgentModelPrimaryValue } from "../../../config/model-input.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { LEGACY_IMPLICIT_PRIMARY_MODEL_REF } from "../../../config/utility-model-separation-migration.js";

/**
 * Releases through 2026.11.6 ran `openai/gpt-6-astra` when config named no model. Runtime no
 * longer invents a model, so an install that relied on it with working OpenAI credentials gets
 * that model written as its configured primary. Without OpenAI credentials it ran nothing useful,
 * so nothing is written and the next turn names how to choose a model.
 */
export async function preserveImplicitOpenAIPrimary(
  cfg: OpenClawConfig,
  options: { env: NodeJS.ProcessEnv },
): Promise<{ config: OpenClawConfig; changes: string[] }> {
  const unchanged = { config: cfg, changes: [] };
  const defaultsModel = cfg.agents?.defaults?.model;
  const agentId = listAgentIds(cfg).find(
    (candidate) => !resolveAgentEffectiveModelPrimary(cfg, candidate),
  );
  if (
    !agentId ||
    resolveAgentModelPrimaryValue(defaultsModel) ||
    resolveConfiguredProviderFallback({ cfg })
  ) {
    return unchanged;
  }
  const agentDir = resolveAgentDir(cfg, agentId, options.env);
  const authStore = await loadAuthProfileStoreForSecretsRuntimeAsync(agentDir, {
    config: cfg,
    externalCli: { mode: "scoped", providerIds: ["openai"], allowKeychainPrompt: false },
  });
  const evaluation = createModelAuthAvailabilityResolver({
    cfg,
    agentId,
    agentDir,
    authStore,
    env: options.env,
    externalCliProviderIds: ["openai"],
  }).evaluateModelAuth("openai", {
    modelId: LEGACY_IMPLICIT_PRIMARY_MODEL_REF.slice("openai/".length),
  });
  if (evaluation.availability === false) {
    return unchanged;
  }
  return {
    config: {
      ...cfg,
      agents: {
        ...cfg.agents,
        defaults: {
          ...cfg.agents?.defaults,
          model: {
            ...(isRecord(defaultsModel) ? defaultsModel : {}),
            primary: LEGACY_IMPLICIT_PRIMARY_MODEL_REF,
          },
        },
      },
    },
    changes: [
      `Set agents.defaults.model.primary to ${LEGACY_IMPLICIT_PRIMARY_MODEL_REF}: earlier releases ran it when no model was configured, and OpenAI credentials are available.`,
    ],
  };
}
