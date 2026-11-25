import { findNormalizedProviderValue } from "@openclaw/model-catalog-core/provider-id";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  listAgentIds,
  resolveAgentDir,
  resolveAgentEffectiveModelPrimary,
} from "../../../agents/agent-scope.js";
import { loadAuthProfileStoreForSecretsRuntimeAsync } from "../../../agents/auth-profiles/store-runtime.js";
import { DEFAULT_PROVIDER } from "../../../agents/defaults.js";
import { createModelAuthAvailabilityResolver } from "../../../agents/model-auth-availability.js";
import { resolveDefaultModelForAgent } from "../../../agents/model-selection-config.js";
import { resolveConfiguredPrimaryProviderFallback } from "../../../agents/model-selection-shared.js";
import { isImplicitPrimaryEraConfig } from "../../../config/implicit-primary-era.js";
import { resolveAgentModelPrimaryValue } from "../../../config/model-input.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { LEGACY_IMPLICIT_PRIMARY_MODEL_REF } from "../../../config/utility-model-separation-migration.js";

const LEGACY_MODEL_ID = LEGACY_IMPLICIT_PRIMARY_MODEL_REF.slice("openai/".length);

/**
 * Releases through 2026.11.6 picked a model when config named none: `openai/gpt-6-astra` when
 * OpenAI listed it or no provider row stood in, otherwise the first non-utility provider row.
 * Runtime no longer invents one, and its provider-row fallback ignores the OpenAI preference, so
 * a config last written by such a release gets the model it ran written as its primary. A config
 * from a newer release is left alone: missing intent there is the user's state, not a migration.
 * The OpenAI default is written only with usable OpenAI credentials; without them it ran nothing.
 */
export async function preserveImplicitOpenAIPrimary(
  cfg: OpenClawConfig,
  options: { env: NodeJS.ProcessEnv },
): Promise<{ config: OpenClawConfig; changes: string[] }> {
  const unchanged = { config: cfg, changes: [] };
  const defaultsModel = cfg.agents?.defaults?.model;
  const affected = listAgentIds(cfg).filter(
    (candidate) => !resolveAgentEffectiveModelPrimary(cfg, candidate),
  );
  if (
    affected.length === 0 ||
    resolveAgentModelPrimaryValue(defaultsModel) ||
    !isImplicitPrimaryEraConfig(cfg)
  ) {
    return unchanged;
  }
  const listsLegacyDefault = findNormalizedProviderValue(
    cfg.models?.providers,
    "openai",
  )?.models?.some((model) => model?.id === LEGACY_MODEL_ID);
  // Each agent ran its own implicit pick; the utility exclusion can differ per agent.
  const legacyFor = (agentId: string) => {
    const fallback = listsLegacyDefault
      ? null
      : resolveConfiguredPrimaryProviderFallback({
          cfg,
          agentId,
          defaultProvider: DEFAULT_PROVIDER,
        });
    return fallback ? `${fallback.provider}/${fallback.model}` : LEGACY_IMPLICIT_PRIMARY_MODEL_REF;
  };
  const legacies = new Map(affected.map((agentId) => [agentId, legacyFor(agentId)]));
  const preserved: string[] = [];
  for (const [agentId, legacy] of legacies) {
    const current = resolveDefaultModelForAgent({ cfg, agentId });
    if (current && `${current.provider}/${current.model}` === legacy) {
      continue;
    }
    if (
      legacy !== LEGACY_IMPLICIT_PRIMARY_MODEL_REF ||
      (await hasOpenAIAuth(cfg, agentId, options.env))
    ) {
      preserved.push(agentId);
    }
  }
  if (preserved.length === 0) {
    return unchanged;
  }
  const refs = new Set(legacies.values());
  if (refs.size === 1) {
    // Every affected agent ran the same model, so one default restores all of them.
    const [legacy] = refs;
    return {
      config: {
        ...cfg,
        agents: {
          ...cfg.agents,
          defaults: {
            ...cfg.agents?.defaults,
            model: { ...(isRecord(defaultsModel) ? defaultsModel : {}), primary: legacy },
          },
        },
      },
      changes: [
        `Set agents.defaults.model.primary to ${legacy}: the model earlier releases ran when no model was configured.`,
      ],
    };
  }
  const entries = { ...cfg.agents?.entries };
  const changes = preserved.map((agentId) => {
    const legacy = legacies.get(agentId);
    const entry = entries[agentId];
    entries[agentId] = {
      ...entry,
      model: { ...(isRecord(entry?.model) ? entry.model : {}), primary: legacy },
    };
    return `Set agents.entries.${agentId}.model.primary to ${legacy}: the model earlier releases ran for this agent when no model was configured.`;
  });
  return { config: { ...cfg, agents: { ...cfg.agents, entries } }, changes };
}

async function hasOpenAIAuth(cfg: OpenClawConfig, agentId: string, env: NodeJS.ProcessEnv) {
  const agentDir = resolveAgentDir(cfg, agentId, env);
  // Doctor is best effort: an unreadable store is reported by its own repair, not here.
  const authStore = await loadAuthProfileStoreForSecretsRuntimeAsync(agentDir, {
    config: cfg,
    externalCli: { mode: "scoped", providerIds: ["openai"], allowKeychainPrompt: false },
  }).catch(() => undefined);
  if (!authStore) {
    return false;
  }
  const evaluation = createModelAuthAvailabilityResolver({
    cfg,
    agentId,
    agentDir,
    authStore,
    env,
    externalCliProviderIds: ["openai"],
  }).evaluateModelAuth("openai", { modelId: LEGACY_MODEL_ID });
  // Only positive evidence counts; an unknown credential leaves the setup message as the outcome.
  return evaluation.availability === true;
}
