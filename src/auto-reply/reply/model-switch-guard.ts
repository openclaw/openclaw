import { resolveContextTokensForModel } from "../../agents/context.js";
import { resolveCompactionReserveTokensFloor } from "../../agents/pi-settings.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { formatTokenCount } from "../../utils/usage-format.js";

function resolveRecordedSessionTokens(
  entry?: Pick<SessionEntry, "totalTokens" | "totalTokensFresh"> | null,
): number | undefined {
  const total = entry?.totalTokens;
  if (typeof total !== "number" || !Number.isFinite(total) || total <= 0) {
    return undefined;
  }
  return Math.floor(total);
}

export function maybeBlockOversizedModelSwitch(params: {
  cfg: OpenClawConfig;
  sessionEntry?: Pick<SessionEntry, "totalTokens" | "totalTokensFresh"> | null;
  currentProvider?: string;
  currentModel?: string;
  targetProvider: string;
  targetModel: string;
}): string | undefined {
  if (
    params.currentProvider?.trim() === params.targetProvider &&
    params.currentModel?.trim() === params.targetModel
  ) {
    return undefined;
  }

  const recordedTokens = resolveRecordedSessionTokens(params.sessionEntry);
  if (recordedTokens === undefined) {
    return undefined;
  }

  const contextWindowTokens = resolveContextTokensForModel({
    cfg: params.cfg,
    provider: params.targetProvider,
    model: params.targetModel,
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
    `Can't switch to ${params.targetProvider}/${params.targetModel} yet.`,
    "",
    `Recorded session context: ${formatTokenCount(recordedTokens)} tokens.`,
    `Target model budget: about ${formatTokenCount(safeBudgetTokens)}/${formatTokenCount(contextWindowTokens)} tokens (reserve ${formatTokenCount(reserveTokens)}).`,
    "Run /compact first, or use /new to start a fresh session before switching.",
    "Current model unchanged.",
  ].join("\n");
}
