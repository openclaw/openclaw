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
import { resolveAgentModelPrimaryValue } from "../../../config/model-input.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { LEGACY_IMPLICIT_PRIMARY_MODEL_REF } from "../../../config/utility-model-separation-migration.js";
import { compareOpenClawVersions } from "../../../config/version.js";

/** The last release that ran an implicit model when config named none. */
const LAST_IMPLICIT_PRIMARY_RELEASE = "2026.11.6";
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
  const touched = cfg.meta?.lastTouchedVersion;
  const agentId = listAgentIds(cfg).find(
    (candidate) => !resolveAgentEffectiveModelPrimary(cfg, candidate),
  );
  if (
    !agentId ||
    resolveAgentModelPrimaryValue(defaultsModel) ||
    (touched !== undefined &&
      (compareOpenClawVersions(touched, LAST_IMPLICIT_PRIMARY_RELEASE) ?? 1) > 0)
  ) {
    return unchanged;
  }
  const listsLegacyDefault = findNormalizedProviderValue(
    cfg.models?.providers,
    "openai",
  )?.models?.some((model) => model?.id === LEGACY_MODEL_ID);
  const fallback = listsLegacyDefault
    ? null
    : resolveConfiguredPrimaryProviderFallback({ cfg, agentId, defaultProvider: DEFAULT_PROVIDER });
  const legacy = fallback
    ? `${fallback.provider}/${fallback.model}`
    : LEGACY_IMPLICIT_PRIMARY_MODEL_REF;
  const current = resolveDefaultModelForAgent({ cfg, agentId });
  if (current && `${current.provider}/${current.model}` === legacy) {
    return unchanged;
  }
  if (legacy === LEGACY_IMPLICIT_PRIMARY_MODEL_REF) {
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
    }).evaluateModelAuth("openai", { modelId: LEGACY_MODEL_ID });
    if (evaluation.availability === false) {
      return unchanged;
    }
  }
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
