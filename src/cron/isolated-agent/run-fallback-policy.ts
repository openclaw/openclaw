/** Resolves model fallback chains for isolated cron runs and preflight. */
import { resolveModelCandidateChain } from "../../agents/model-fallback.js";
import type { ModelCandidate } from "../../agents/model-fallback.types.js";
import { resolveAgentModelFallbackValues } from "../../config/model-input.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { CronJob } from "../types.js";
import {
  resolveEffectiveModelFallbacks,
  resolveSubagentModelFallbacksOverride,
} from "./run-execution.runtime.js";
import { resolveAgentConfig } from "../../agents/agent-scope-config.js";

/**
 * Checks if agent model config lacks explicit fallbacks (string or object without fallbacks field).
 * In these cases, isolated cron sessions should inherit global defaults.
 */
function agentModelLacksExplicitFallbacks(cfg: OpenClawConfig, agentId: string): boolean {
  const agentConfig = resolveAgentConfig(cfg, agentId);
  const model = agentConfig?.model;
  if (!model) {
    return false;
  }
  // String model (e.g. "deepseek/v4-pro") has no fallbacks field
  if (typeof model === "string") {
    return true;
  }
  // Object model without fallbacks field should inherit defaults
  if (typeof model === "object" && !Object.hasOwn(model, "fallbacks")) {
    return true;
  }
  return false;
}

/** Resolves cron model fallbacks, giving explicit payload fallbacks precedence over subagent/default policy. */
export function resolveCronFallbacksOverride(params: {
  cfg: OpenClawConfig;
  job: CronJob;
  agentId: string;
  useSubagentFallbacks?: boolean;
}): string[] | undefined {
  const payload = params.job.payload.kind === "agentTurn" ? params.job.payload : undefined;
  const payloadFallbacks = Array.isArray(payload?.fallbacks) ? payload.fallbacks : undefined;
  const hasCronPayloadModelOverride =
    typeof payload?.model === "string" && payload.model.trim().length > 0;
  if (payloadFallbacks !== undefined) {
    return payloadFallbacks;
  }
  if (params.useSubagentFallbacks === true && !hasCronPayloadModelOverride) {
    // A payload model override owns its full candidate chain; otherwise the
    // selected subagent can contribute its configured fallback policy.
    const subagentFallbacksOverride = resolveSubagentModelFallbacksOverride(
      params.cfg,
      params.agentId,
    );
    if (subagentFallbacksOverride !== undefined) {
      return subagentFallbacksOverride;
    }
  }
  const effectiveFallbacks = resolveEffectiveModelFallbacks({
    cfg: params.cfg,
    agentId: params.agentId,
    hasSessionModelOverride: hasCronPayloadModelOverride,
    modelOverrideSource: hasCronPayloadModelOverride ? "auto" : undefined,
  });
  // For isolated cron sessions, inherit global fallbacks when agent model lacks explicit fallbacks.
  // This fixes #91362 - agents.defaults.model.fallbacks not inherited by isolated cron sessions.
  if (
    effectiveFallbacks !== undefined &&
    effectiveFallbacks.length === 0 &&
    !hasCronPayloadModelOverride &&
    agentModelLacksExplicitFallbacks(params.cfg, params.agentId)
  ) {
    return resolveAgentModelFallbackValues(params.cfg.agents?.defaults?.model);
  }
  return effectiveFallbacks;
}

/** Builds the ordered model candidates used by cron preflight checks. */
export function resolveCronPreflightCandidates(params: {
  cfg: OpenClawConfig;
  job: CronJob;
  agentId: string;
  provider: string;
  model: string;
  useSubagentFallbacks?: boolean;
}): ModelCandidate[] {
  const fallbacksOverride = resolveCronFallbacksOverride({
    cfg: params.cfg,
    job: params.job,
    agentId: params.agentId,
    useSubagentFallbacks: params.useSubagentFallbacks,
  });
  return resolveModelCandidateChain({
    cfg: params.cfg,
    provider: params.provider,
    model: params.model,
    fallbacksOverride,
  });
}
