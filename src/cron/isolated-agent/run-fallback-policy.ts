/** Resolves model fallback chains for isolated cron runs and preflight. */
import { resolveModelCandidateChain } from "../../agents/model-fallback.js";
import type { ModelCandidate } from "../../agents/model-fallback.types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { CronJob } from "../types.js";
import {
  resolveAgentModelInheritableFallbacksOverride,
  resolveEffectiveModelFallbacks,
  resolveSubagentModelFallbacksOverride,
} from "./run-execution.runtime.js";

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
  if (hasCronPayloadModelOverride) {
    // A payload model override behaves like an auto model selection and keeps the
    // configured agent/global fallback chain.
    return resolveEffectiveModelFallbacks({
      cfg: params.cfg,
      agentId: params.agentId,
      hasSessionModelOverride: true,
      modelOverrideSource: "auto",
    });
  }
  // No payload model override: the job runs the agent's configured model. A plain-string
  // or primary-only agent model has no explicit fallbacks, so leave the override unset and
  // let the runner inherit agents.defaults.model.fallbacks instead of pinning the job to a
  // single-model chain. An explicit agent `fallbacks` list (including []) stays authoritative.
  return resolveAgentModelInheritableFallbacksOverride(params.cfg, params.agentId);
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
