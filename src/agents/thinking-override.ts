import type { OpenClawConfig } from "../config/types.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { resolveThinkingDefault, type ThinkLevel } from "./model-selection.js";

export async function resolveThinkingLevelOverride(params: {
  cfg: OpenClawConfig;
  provider: string;
  model: string;
  prompt: string;
  explicitOverride?: ThinkLevel;
  sessionOverride?: ThinkLevel;
  recentMessages?: string[];
  attachmentCount?: number;
  catalog?: Parameters<typeof resolveThinkingDefault>[0]["catalog"];
  logger?: (line: string) => void;
}): Promise<ThinkLevel> {
  if (params.explicitOverride) {
    return params.explicitOverride;
  }
  if (params.sessionOverride) {
    return params.sessionOverride;
  }

  const currentThinkingDefault = resolveThinkingDefault({
    cfg: params.cfg,
    provider: params.provider,
    model: params.model,
    catalog: params.catalog,
  });

  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("before_model_resolve")) {
    return currentThinkingDefault;
  }

  const result = await hookRunner.runBeforeModelResolve(
    {
      prompt: params.prompt,
      provider: params.provider,
      model: params.model,
      currentThinkingDefault,
      explicitThinkingLevel: params.explicitOverride,
      sessionThinkingLevel: params.sessionOverride,
      recentMessages: params.recentMessages,
      attachmentCount: params.attachmentCount,
    },
    {},
  );

  if (result?.thinkingLevelOverride) {
    params.logger?.(`[hooks] thinking overridden to ${result.thinkingLevelOverride}`);
    return result.thinkingLevelOverride;
  }

  return currentThinkingDefault;
}
