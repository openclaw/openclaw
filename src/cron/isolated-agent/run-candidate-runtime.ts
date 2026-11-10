import { resolveCliRuntimeExecutionProvider } from "../../agents/model-runtime-aliases.js";
import {
  assertCronCandidateSandboxPlacement,
  resolveCronSandboxPlacement,
  type CronSandboxPlacement,
} from "./run-admission.js";
import { isCliProvider } from "./run-execution.runtime.js";
import type { CronRunExecutionParams } from "./run-execution.types.js";
import { resolveEffectiveAgentRuntime } from "./run.runtime.js";

/** Shares candidate execution policy between harness preparation and dispatch. */
export function createCronCandidateExecutionResolver(
  params: Pick<
    CronRunExecutionParams,
    "cfgWithAgentDefaults" | "agentId" | "runSessionKey" | "cronSession"
  >,
) {
  let sandboxPlacement: CronSandboxPlacement | undefined;
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
    // Every candidate uses the prepared session's containment facts, including
    // harness preparation, fallbacks, and runtime overrides before host dispatch.
    sandboxPlacement ??= resolveCronSandboxPlacement({
      cfg: params.cfgWithAgentDefaults,
      agentId: params.agentId,
      sessionKey: params.runSessionKey,
      preparedSessionEntry: params.cronSession.sessionEntry,
    });
    assertCronCandidateSandboxPlacement({ ...sandboxPlacement, cliExecution, executionProvider });
    return {
      sessionRuntimeOverride,
      executionProvider,
      cliExecution,
      runtime,
    };
  };
}
