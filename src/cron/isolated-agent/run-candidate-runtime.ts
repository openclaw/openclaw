import { resolveSessionRuntimeOverrideForProvider } from "../../agents/session-runtime-compat.js";
import { resolveCronRuntimeSessionEntry } from "../inference-binding.js";
import { resolveCronCandidateExecution } from "./candidate-execution.js";
import { isCliProvider } from "./run-execution.runtime.js";
import type { CronRunExecutionParams } from "./run-execution.types.js";
import { resolveEffectiveAgentRuntime } from "./run.runtime.js";

/** Resolves a candidate's runtime override from the job's captured runtime or its cron session. */
export function createCronRuntimeOverrideResolver(
  params: Pick<CronRunExecutionParams, "cfgWithAgentDefaults" | "cronSession" | "job">,
) {
  return (provider: string) =>
    resolveSessionRuntimeOverrideForProvider({
      provider,
      entry: resolveCronRuntimeSessionEntry(
        params.job.inferenceBinding,
        params.cronSession.sessionEntry,
      ),
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
        // A captured runtime stands in for the override copied into the cron session entry.
        sessionEntry: resolveCronRuntimeSessionEntry(
          params.job.inferenceBinding,
          params.cronSession.sessionEntry,
        ),
      },
      { isCliProvider, resolveEffectiveAgentRuntime },
    );
}
