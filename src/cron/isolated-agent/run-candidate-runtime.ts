import { resolveSessionRuntimeOverrideForProvider } from "../../agents/session-runtime-compat.js";
import { resolveCronModelPin, resolveCronRuntimeSessionEntry } from "../run-inference.js";
import { resolveCronCandidateExecution } from "./candidate-execution.js";
import { isCliProvider } from "./run-execution.runtime.js";
import type { CronRunExecutionParams } from "./run-execution.types.js";
import { resolveEffectiveAgentRuntime } from "./run.runtime.js";

/** Resolves a candidate's runtime override from the job's pinned runtime or its cron session. */
export function createCronRuntimeOverrideResolver(
  params: Pick<CronRunExecutionParams, "cfgWithAgentDefaults" | "cronSession" | "job" | "agentId">,
) {
  const modelPin = resolveCronModelPin(params.job, params.cfgWithAgentDefaults, params.agentId);
  return (provider: string) =>
    resolveSessionRuntimeOverrideForProvider({
      provider,
      entry: resolveCronRuntimeSessionEntry(modelPin, params.cronSession.sessionEntry, provider),
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
  const modelPin = resolveCronModelPin(params.job, params.cfgWithAgentDefaults, params.agentId);
  return (provider: string, model: string, sessionRuntimeOverride: string | undefined) =>
    resolveCronCandidateExecution(
      {
        cfg: params.cfgWithAgentDefaults,
        agentId: params.agentId,
        provider,
        model,
        sessionRuntimeOverride,
        sessionKey: params.runSessionKey,
        // A pinned runtime stands in for the override copied into the cron session entry.
        sessionEntry: resolveCronRuntimeSessionEntry(
          modelPin,
          params.cronSession.sessionEntry,
          provider,
        ),
      },
      { isCliProvider, resolveEffectiveAgentRuntime },
    );
}
