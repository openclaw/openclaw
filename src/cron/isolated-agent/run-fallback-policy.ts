import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { hasCronPayloadModelOverride as hasCronPayloadModelOverrideValue } from "../model-override.js";
import type { CronJob } from "../types.js";
import { resolveEffectiveModelFallbacks } from "./run-execution.runtime.js";

export function resolveCronFallbacksOverride(params: {
  cfg: OpenClawConfig;
  job: CronJob;
  agentId: string;
}): string[] | undefined {
  const payload = params.job.payload.kind === "agentTurn" ? params.job.payload : undefined;
  const payloadFallbacks = Array.isArray(payload?.fallbacks) ? payload.fallbacks : undefined;
  const hasCronPayloadModelOverride = hasCronPayloadModelOverrideValue(payload?.model);
  return (
    payloadFallbacks ??
    resolveEffectiveModelFallbacks({
      cfg: params.cfg,
      agentId: params.agentId,
      hasSessionModelOverride: hasCronPayloadModelOverride,
      modelOverrideSource: hasCronPayloadModelOverride ? "auto" : undefined,
    })
  );
}
