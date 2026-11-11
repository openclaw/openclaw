import { resolveModelCandidateChain } from "../../agents/model-fallback-candidates.js";
import { resolveConfiguredModelFallbacks } from "../../agents/model-selection-resolve.js";
import { selectLiveRuntimeConfig } from "../../config/runtime-snapshot.js";
import { createCronRunInferenceCandidates } from "../../cron/run-inference.js";
import type { AgentTurnParams } from "./agent-runner-execution.types.js";
import { resolveModelFallbackOptions } from "./agent-runner-run-params.js";

/** The session adapter derives one scheduled policy and retains its leases through settlement. */
export async function prepareReplyScheduledInference(params: AgentTurnParams) {
  const run = params.followupRun.run;
  const job = run.scheduledAutomation?.job;
  if (!job) {
    return undefined;
  }
  const cfg = selectLiveRuntimeConfig(run.config);
  const selection = resolveModelFallbackOptions(run, cfg);
  const { inheritCronInferencePolicy } = await import("../../cron/inference-binding.runtime.js");
  const primary = { provider: run.provider, model: run.model };
  const policy = await inheritCronInferencePolicy({
    cfg,
    agentId: run.agentId,
    job,
    primary,
    candidates: resolveModelCandidateChain(selection),
    fallbacks:
      selection.fallbacksOverride ?? resolveConfiguredModelFallbacks({ cfg, agentId: run.agentId }),
    primaryProfileId: run.authProfileId,
    runtimeSessionEntry: params.getActiveSessionEntry(),
  });
  return createCronRunInferenceCandidates({ ...policy, primary, cfg, agentDir: run.agentDir });
}
