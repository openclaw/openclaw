/** Orchestrates isolated cron prompts, live model switches, and interim-ack retries. */
import {
  getGeneratedMediaTaskIdsForSessionKey,
  hasNewGeneratedMediaTaskForSessionKey,
} from "../../agents/media-generation-activity.js";
import type { VerboseLevel } from "../../auto-reply/thinking.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import { resolveCronChannelOutputPolicy } from "./channel-output-policy.js";
import { resolveCronPayloadOutcome } from "./helpers.js";
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
import { isLikelyInterimCronMessage } from "./subagent-followup-hints.js";

type CronSubagentRegistryRuntime = typeof import("./run-subagent-registry.runtime.js");

const cronSubagentRegistryRuntimeLoader = createLazyImportLoader<CronSubagentRegistryRuntime>(
  () => import("./run-subagent-registry.runtime.js"),
);

/** Executes an isolated cron prompt, including live model-switch and interim-ack retries. */
export async function executeCronRun(params: CronRunExecutionParams): Promise<CronExecutionResult> {
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

  const { runResult } = execution;
  if (!params.isAborted()) {
    const interimPayloads = runResult.payloads ?? [];
    const {
      deliveryPayloadHasStructuredContent: interimPayloadHasStructuredContent,
      hasFatalErrorPayload: interimHasFatalErrorPayload,
      outputText: interimOutputText,
    } = resolveCronPayloadOutcome({
      payloads: interimPayloads,
      runLevelError: runResult.meta?.error,
      failureSignal: runResult.meta?.failureSignal,
      finalAssistantVisibleText: runResult.meta?.finalAssistantVisibleText,
      preferFinalAssistantVisibleText: (
        await resolveCronChannelOutputPolicy(params.resolvedDelivery.channel, {
          deliveryRequested: params.deliveryRequested,
        })
      ).preferFinalAssistantVisibleText,
    });
    const shouldRetryInterimAck =
      !runResult.meta?.error &&
      !interimHasFatalErrorPayload &&
      !runResult.didSendViaMessagingTool &&
      !hasNewGeneratedMediaTaskForSessionKey(params.runSessionKey, promptMediaTaskIds) &&
      !interimPayloadHasStructuredContent &&
      !interimPayloads.some((payload) => payload?.isError === true) &&
      isLikelyInterimCronMessage(interimOutputText ?? "");

    let hasFreshDescendants = false;
    let hasActiveDescendants = false;
    if (shouldRetryInterimAck) {
      const { readDescendantExecutionState } = await cronSubagentRegistryRuntimeLoader.load();
      const descendants = await readDescendantExecutionState(params.runSessionKey, runStartedAt);
      hasFreshDescendants = descendants.hasFreshDescendants;
      hasActiveDescendants = descendants.hasActiveDescendants;
    }

    if (
      shouldRetryInterimAck &&
      !params.isAborted() &&
      !hasFreshDescendants &&
      !hasActiveDescendants
    ) {
      // Retry a bare acknowledgement only when no descendant subagent was
      // spawned; otherwise delivery waits for the subagent follow-up path.
      const continuationPrompt = [
        "Your previous response was only an acknowledgement and did not complete this cron task.",
        "Complete the original task now.",
        "Do not send a status update like 'on it'.",
        "Use tools when needed, including sessions_spawn for parallel subtasks, wait for spawned subagents to finish, then return only the final summary.",
      ].join(" ");
      execution = await runPrompt(continuationPrompt, Date.now());
    }
  }

  return {
    ...execution,
    runStartedAt,
    completedPromptRuns,
  };
}
