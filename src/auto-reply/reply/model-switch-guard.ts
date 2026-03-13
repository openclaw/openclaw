import { lookupContextTokens } from "../../agents/context.js";
import { resolveCompactionReserveTokensFloor } from "../../agents/pi-settings.js";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveFreshSessionTotalTokens, type SessionEntry } from "../../config/sessions.js";
import { formatTokenCount } from "../../utils/usage-format.js";

function normalizePositiveInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}

function resolveConfiguredModelContextWindow(params: {
  cfg: OpenClawConfig;
  model: string;
}): number | undefined {
  const providers = params.cfg.models?.providers;
  if (!providers || typeof providers !== "object") {
    return undefined;
  }

  let smallest: number | undefined;
  for (const providerConfig of Object.values(providers)) {
    const models = providerConfig?.models;
    if (!Array.isArray(models)) {
      continue;
    }
    for (const modelConfig of models) {
      if (
        modelConfig?.id !== params.model ||
        typeof modelConfig.contextWindow !== "number" ||
        !Number.isFinite(modelConfig.contextWindow) ||
        modelConfig.contextWindow <= 0
      ) {
        continue;
      }
      const contextWindow = Math.floor(modelConfig.contextWindow);
      if (smallest === undefined || contextWindow < smallest) {
        smallest = contextWindow;
      }
    }
  }
  return smallest;
}

function resolveEffectiveContextWindowTokens(params: {
  cfg: OpenClawConfig;
  model: string;
}): number | undefined {
  const cachedWindow = normalizePositiveInt(lookupContextTokens(params.model));
  const configuredWindow = resolveConfiguredModelContextWindow(params);
  const contextWindow = cachedWindow ?? configuredWindow;
  const configuredCap = normalizePositiveInt(params.cfg.agents?.defaults?.contextTokens);
  if (contextWindow === undefined) {
    // Refuse a switch only when we have a real budget signal. Falling back to
    // the global default here would block unknown/high-context models purely
    // because the catalog is incomplete.
    return configuredCap;
  }

  if (configuredCap !== undefined && configuredCap < contextWindow) {
    return configuredCap;
  }

  return contextWindow;
}

export function maybeBlockOversizedModelSwitch(params: {
  cfg: OpenClawConfig;
  sessionEntry?: Pick<SessionEntry, "totalTokens" | "totalTokensFresh"> | null;
  currentProvider?: string;
  currentModel?: string;
  targetProvider: string;
  targetModel: string;
}): string | undefined {
  const currentProvider = params.currentProvider?.trim();
  const currentModel = params.currentModel?.trim();
  const targetProvider = params.targetProvider.trim();
  const targetModel = params.targetModel.trim();

  if (currentProvider === targetProvider && currentModel === targetModel) {
    return undefined;
  }

  const recordedTokens = resolveFreshSessionTotalTokens(params.sessionEntry);
  if (recordedTokens === undefined) {
    return undefined;
  }

  const contextWindowTokens = resolveEffectiveContextWindowTokens({
    cfg: params.cfg,
    model: targetModel,
  });
  if (
    typeof contextWindowTokens !== "number" ||
    !Number.isFinite(contextWindowTokens) ||
    contextWindowTokens <= 0
  ) {
    return undefined;
  }

  const reserveTokens = Math.min(
    Math.max(0, resolveCompactionReserveTokensFloor(params.cfg)),
    Math.max(0, contextWindowTokens - 1),
  );
  // Refuse switches that would immediately drop the session into an unsafe
  // budget for the target model on the very next turn.
  const safeBudgetTokens = Math.max(1, contextWindowTokens - reserveTokens);
  if (recordedTokens <= safeBudgetTokens) {
    return undefined;
  }

  return [
    `Can't switch to ${targetProvider}/${targetModel} yet.`,
    "",
    `Recorded session context: ${formatTokenCount(recordedTokens)} tokens.`,
    `Target model budget: about ${formatTokenCount(safeBudgetTokens)}/${formatTokenCount(contextWindowTokens)} tokens (reserve ${formatTokenCount(reserveTokens)}).`,
    "Run /compact first, or use /new to start a fresh session before switching.",
    "Current model unchanged.",
  ].join("\n");
}
