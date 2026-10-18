import { recordModelFallbackStop } from "../../agents/model-fallback-stop.js";
import { resolveCliRuntimeExecutionProvider } from "../../agents/model-runtime-aliases.js";
import { isCliProvider } from "./run-execution.runtime.js";
import type { CronRunExecutionParams } from "./run-execution.types.js";
import { resolveEffectiveAgentRuntime } from "./run.runtime.js";

/** Shares candidate execution policy between harness preparation and dispatch. */
export function createCronCandidateExecutionResolver(
  params: Pick<
    CronRunExecutionParams,
    "cfgWithAgentDefaults" | "agentId" | "runSessionKey" | "cronSession" | "agentPayload"
  >,
) {
  return (provider: string, model: string, sessionRuntimeOverride: string | undefined) => {
    const executionProvider = sessionRuntimeOverride
      ? isCliProvider(sessionRuntimeOverride, params.cfgWithAgentDefaults)
        ? sessionRuntimeOverride
        : provider
      : (resolveCliRuntimeExecutionProvider({
          provider,
          cfg: params.cfgWithAgentDefaults,
          agentId: params.agentId,
          modelId: model,
        }) ?? provider);
    const runtime =
      sessionRuntimeOverride ??
      resolveEffectiveAgentRuntime({
        cfg: params.cfgWithAgentDefaults,
        provider,
        modelId: model,
        agentId: params.agentId,
        sessionKey: params.runSessionKey,
        sessionEntry: params.cronSession.sessionEntry,
      });
    const cliExecution = isCliProvider(executionProvider, params.cfgWithAgentDefaults);
    if (cliExecution && params.agentPayload?.webSearchProvider !== undefined) {
      const refusal = new Error("webSearchProvider is not supported with CLI backends.");
      recordModelFallbackStop(refusal);
      throw refusal;
    }
    return {
      sessionRuntimeOverride,
      executionProvider,
      cliExecution,
      runtime,
    };
  };
}
