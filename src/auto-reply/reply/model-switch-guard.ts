import { resolveContextTokensForModel } from "../../agents/context.js";
import { resolveCompactionReserveTokensFloor } from "../../agents/pi-settings.js";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveFreshSessionTotalTokens, type SessionEntry } from "../../config/sessions.js";
import { formatTokenCount } from "../../utils/usage-format.js";

function resolveEffectiveContextWindowTokens(params: {
  cfg: OpenClawConfig;
  provider: string;
  model: string;
}): number | undefined {
  const resolved = resolveContextTokensForModel({
    cfg: params.cfg,
    provider: params.provider,
    model: params.model,
  });
  if (typeof resolved !== "number" || !Number.isFinite(resolved) || resolved <= 0) {
    return undefined;
  }

  const modelContextTokens = Math.floor(resolved);
  const configuredCap = params.cfg.agents?.defaults?.contextTokens;
  if (
    typeof configuredCap === "number" &&
    Number.isFinite(configuredCap) &&
    configuredCap > 0 &&
    configuredCap < modelContextTokens
  ) {
    return Math.floor(configuredCap);
  }

  return modelContextTokens;
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
    provider: targetProvider,
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
