import { resolveCliRuntimeExecutionProvider } from "../../agents/model-runtime-aliases.js";
import { resolveSessionRuntimeOverrideForProvider } from "../../agents/session-runtime-compat.js";
import { resolveSkillCollectionReviewRuntimeOverride } from "../skill-collection-review-runtime.js";
import { SKILL_COLLECTION_REVIEW_DECLARATION_PREFIX } from "../system-owned-declaration.js";
import { isCliProvider } from "./run-execution.runtime.js";
import type { CronRunExecutionParams } from "./run-execution.types.js";
import { resolveEffectiveAgentRuntime } from "./run.runtime.js";

/** Shares candidate execution policy between harness preparation and dispatch. */
export function createCronCandidateExecutionResolver(
  params: Pick<
    CronRunExecutionParams,
    "cfgWithAgentDefaults" | "agentId" | "runSessionKey" | "cronSession" | "job" | "executionRoot"
  >,
) {
  const isSkillCollectionReview = Boolean(
    params.executionRoot &&
    params.job.declarationKey === `${SKILL_COLLECTION_REVIEW_DECLARATION_PREFIX}${params.agentId}`,
  );
  const resolveRuntimeOverride = (provider: string, modelId: string) =>
    isSkillCollectionReview
      ? resolveSkillCollectionReviewRuntimeOverride({
          config: params.cfgWithAgentDefaults,
          agentId: params.agentId,
          provider,
          modelId,
          sessionEntry: params.cronSession.sessionEntry,
        })
      : resolveSessionRuntimeOverrideForProvider({
          cfg: params.cfgWithAgentDefaults,
          provider,
          entry: params.cronSession.sessionEntry,
        });
  const resolveExecution = (
    provider: string,
    model: string,
    sessionRuntimeOverride = resolveRuntimeOverride(provider, model),
  ) => {
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
    return {
      sessionRuntimeOverride,
      executionProvider,
      cliExecution: isCliProvider(executionProvider, params.cfgWithAgentDefaults),
      runtime,
    };
  };
  return { resolveRuntimeOverride, resolveExecution };
}
