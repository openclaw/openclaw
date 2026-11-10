import { resolveSessionRuntimeOverrideForProvider } from "../../agents/session-runtime-compat.js";
import {
  resolveCronInferenceAccount,
  resolveCronRuntimeSessionEntry,
} from "../inference-binding.js";
import { resolveCronCandidateExecution } from "./candidate-execution.js";
import { isCliProvider } from "./run-execution.runtime.js";
import type { CronRunExecutionParams } from "./run-execution.types.js";
import { resolveEffectiveAgentRuntime } from "./run.runtime.js";

// A captured runtime stands in for the override copied into the cron session entry; each
// provider uses the runtime its own recorded account was captured for.
function candidateRuntimeSessionEntry(
  params: Pick<CronRunExecutionParams, "cronSession" | "job">,
  provider: string,
) {
  const binding = params.job.inferenceBinding;
  return resolveCronRuntimeSessionEntry(
    binding && (resolveCronInferenceAccount(binding, provider) ?? binding),
    params.cronSession.sessionEntry,
  );
}

/** Resolves a candidate's runtime override from the job's captured runtime or its cron session. */
export function createCronRuntimeOverrideResolver(
  params: Pick<CronRunExecutionParams, "cfgWithAgentDefaults" | "cronSession" | "job">,
) {
  return (provider: string) =>
    resolveSessionRuntimeOverrideForProvider({
      provider,
      entry: candidateRuntimeSessionEntry(params, provider),
      cfg: params.cfgWithAgentDefaults,
    });
}

/** Shares candidate execution policy between harness preparation and dispatch. */
export function createCronCandidateExecutionResolver(
  params: Pick<
    CronRunExecutionParams,
    "cfgWithAgentDefaults" | "agentId" | "runSessionKey" | "cronSession" | "job"
  >,
) {
  return (provider: string, model: string, sessionRuntimeOverride: string | undefined) =>
    resolveCronCandidateExecution(
      {
        cfg: params.cfgWithAgentDefaults,
        agentId: params.agentId,
        provider,
        model,
        sessionRuntimeOverride,
        sessionKey: params.runSessionKey,
        sessionEntry: candidateRuntimeSessionEntry(params, provider),
      },
      { isCliProvider, resolveEffectiveAgentRuntime },
    );
}
