import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../../agents/defaults.js";
import type { ModelCandidate } from "../../agents/model-fallback.types.js";
import { modelKey } from "../../agents/model-selection-normalize.js";
import {
  buildModelAliasIndex,
  resolveConfiguredModelRef,
  resolveModelRefFromString,
} from "../../agents/model-selection-resolve.js";
import { resolveAgentModelFallbackValues } from "../../config/model-input.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { CronJob } from "../types.js";
import {
  resolveEffectiveModelFallbacks,
  resolveSubagentModelFallbacksOverride,
} from "./run-execution.runtime.js";

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
    const subagentFallbacksOverride = resolveSubagentModelFallbacksOverride(
      params.cfg,
      params.agentId,
    );
    if (subagentFallbacksOverride !== undefined) {
      return subagentFallbacksOverride;
    }
  }
  return resolveEffectiveModelFallbacks({
    cfg: params.cfg,
    agentId: params.agentId,
    hasSessionModelOverride: hasCronPayloadModelOverride,
    modelOverrideSource: hasCronPayloadModelOverride ? "auto" : undefined,
  });
}

export function resolveCronPreflightFallbackCandidates(params: {
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
  const configuredPrimary = resolveConfiguredModelRef({
    cfg: params.cfg,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  const defaultProvider = configuredPrimary.provider || DEFAULT_PROVIDER;
  const aliasIndex = buildModelAliasIndex({
    cfg: params.cfg,
    defaultProvider,
  });
  const candidates: ModelCandidate[] = [];
  const seen = new Set<string>();
  const addCandidate = (candidate: ModelCandidate) => {
    const key = modelKey(candidate.provider, candidate.model);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    candidates.push(candidate);
  };

  addCandidate({ provider: params.provider, model: params.model });

  const fallbackRefs =
    fallbacksOverride !== undefined
      ? fallbacksOverride
      : resolveAgentModelFallbackValues(params.cfg.agents?.defaults?.model);
  for (const raw of fallbackRefs) {
    const resolved = resolveModelRefFromString({
      cfg: params.cfg,
      raw,
      defaultProvider,
      aliasIndex,
    });
    if (resolved) {
      addCandidate(resolved.ref);
    }
  }

  if (fallbacksOverride === undefined) {
    addCandidate(configuredPrimary);
  }

  return candidates.slice(1);
}
