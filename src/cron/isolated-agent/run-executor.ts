/** Executes isolated cron prompts with model fallbacks. */
import {
  getGeneratedMediaTaskIdsForSessionKey,
  hasNewGeneratedMediaTaskForSessionKey,
} from "../../agents/media-generation-activity.js";
import type { VerboseLevel } from "../../auto-reply/thinking.js";
import { withSessionTurn } from "../../sessions/session-controller.admission.js";
import {
  LiveSessionModelSwitchError,
  logWarn,
  normalizeVerboseLevel,
  registerAgentRunContext,
} from "./run-execution.runtime.js";
import type { CronRunExecutionParams } from "./run-execution.types.js";
import { createCronPromptExecutor } from "./run-prompt-executor.js";
import { syncCronSessionLiveSelection } from "./run-session-state.js";
import type { CronCompletedPromptRun, CronExecutionResult } from "./run.types.js";

/** Executes an isolated cron prompt, including live model-switch retries. */
export async function executeCronRun(params: CronRunExecutionParams): Promise<CronExecutionResult> {
  return await withSessionTurn(
    {
      sessionKey: params.runSessionKey,
      sessionId: params.cronSession.sessionEntry.sessionId,
      agentId: params.agentId,
      storePath: params.cronSession.storePath,
      abortSignal: params.abortSignal,
    },
    (_operation, signal) => executeCronRunOwned({ ...params, abortSignal: signal }),
  );
}

async function executeCronRunOwned(params: CronRunExecutionParams): Promise<CronExecutionResult> {
  const resolvedVerboseLevel: VerboseLevel =
    normalizeVerboseLevel(params.cronSession.sessionEntry.verboseLevel) ??
    normalizeVerboseLevel(params.agentVerboseDefault) ??
    "off";
  registerAgentRunContext(params.runId, {
    sessionEventDelivery: params.sourceDelivery.normalFinal === "private" ? false : undefined,
    sessionId: params.cronSession.sessionEntry.sessionId,
    agentId: params.agentId,
    verboseLevel: resolvedVerboseLevel,
  });
  const runStartedAt = params.runStartedAt ?? Date.now();
  const completedPromptRuns: CronCompletedPromptRun[] = [];
  const runPrompt = createCronPromptExecutor({
    ...params,
    resolvedVerboseLevel,
    onPromptCompleted: (run) => {
      completedPromptRuns.push(run);
      params.onPromptCompleted?.(completedPromptRuns);
    },
  });

  const MAX_MODEL_SWITCH_RETRIES = 2;
  let modelSwitchRetries = 0;
  let promptMediaTaskIds: ReadonlySet<string> = new Set();
  let execution: CronCompletedPromptRun;
  while (true) {
    try {
      promptMediaTaskIds = getGeneratedMediaTaskIdsForSessionKey(params.runSessionKey);
      execution = await runPrompt(params.commandBody, runStartedAt);
      break;
    } catch (err) {
      if (
        !(err instanceof LiveSessionModelSwitchError) ||
        hasNewGeneratedMediaTaskForSessionKey(params.runSessionKey, promptMediaTaskIds)
      ) {
        throw err;
      }
      modelSwitchRetries += 1;
      if (modelSwitchRetries > MAX_MODEL_SWITCH_RETRIES) {
        logWarn(
          `[cron:${params.job.id}] LiveSessionModelSwitchError retry limit reached (${MAX_MODEL_SWITCH_RETRIES}); aborting`,
        );
        throw err;
      }
      params.liveSelection.provider = err.provider;
      params.liveSelection.model = err.model;
      params.liveSelection.agentRuntimeOverride = err.agentRuntimeOverride;
      params.liveSelection.authProfileId = err.authProfileId;
      params.liveSelection.authProfileIdSource = err.authProfileId
        ? err.authProfileIdSource
        : undefined;
      syncCronSessionLiveSelection({
        entry: params.cronSession.sessionEntry,
        liveSelection: params.liveSelection,
      });
      try {
        // Persist the switched model before retrying so later delivery/session
        // metadata agrees with the model that actually handled the run.
        await params.persistSessionEntry();
        await params.persistRunContinuationSession?.();
      } catch (persistErr) {
        logWarn(
          `[cron:${params.job.id}] Failed to persist model switch session entry: ${String(persistErr)}`,
        );
      }
      continue;
    }
  }

  return {
    ...execution,
    runStartedAt,
    completedPromptRuns,
  };
}
