import { resolveSimpleCompletionSelectionForAgent } from "../agents/simple-completion-selection.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { emitAgentEvent, emitAgentEventForOwner } from "../infra/agent-events.js";
import { getAgentRunContextOwnership } from "../infra/agent-run-registry.js";
import { formatErrorMessage } from "../infra/errors.js";
import { redactToolPayloadText } from "../logging/redact.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import {
  buildSessionObserverPrompt,
  type defaultCompleteModel,
  type defaultPrepareModel,
  normalizeSessionObserverModelOutput,
  sanitizeSessionObserverModelText,
  SESSION_OBSERVER_SYSTEM_PROMPT,
  type SessionObserverDeps,
  type SessionObserverState,
} from "./session-observer-model.js";

const observerLog = createSubsystemLogger("gateway/session-observer");
// CLI-backed utility models (for example claude-cli Haiku) take 9-16s per call.
const SESSION_OBSERVER_MODEL_TIMEOUT_MS = 30_000;
const REJECTED_OUTPUT_MAX_CHARS = 160;

export function reportSessionObserverDegradation(
  state: SessionObserverState,
  error: unknown,
  cfg: OpenClawConfig,
) {
  const selection = resolveSimpleCompletionSelectionForAgent({
    cfg,
    agentId: state.agentId,
    modelRef: state.utilityModelRef,
    useUtilityModel: "required",
  });
  const modelLabel = selection ? ` "${selection.provider}/${selection.modelId}"` : "";
  const notice = {
    runId: state.runId,
    sessionKey: state.sessionKey,
    agentId: state.agentId,
    stream: "notice",
    data: {
      phase: "warning",
      message: `Session observer assessments stopped for this run after utility model${modelLabel} failed repeatedly. To restore assessments, choose a capable utility model or add capable utilityModel.fallbacks.`,
    },
  };
  const owner = getAgentRunContextOwnership(state.runId)?.exclusiveClaimId;
  if (owner) {
    emitAgentEventForOwner(notice, owner);
  } else {
    emitAgentEvent(notice);
  }
  observerLog.warn("session observer disabled after consecutive failures", {
    sessionKey: state.sessionKey,
    runId: state.runId,
    consecutiveFailures: state.consecutiveFailures,
    error: formatErrorMessage(error),
  });
}

export function createSessionObserverCompletion(params: {
  getConfig: SessionObserverDeps["getConfig"];
  prepareModel: typeof defaultPrepareModel;
  completeModel: typeof defaultCompleteModel;
  isCurrent: (state: SessionObserverState) => boolean;
}) {
  const ensurePrepared = async (state: SessionObserverState) => {
    const modelRef = state.utilityModelRef;
    if (!modelRef) {
      throw new Error("session observer utility model is unavailable");
    }
    const preparedPromise = (state.preparedPromise ??= params.prepareModel({
      cfg: params.getConfig(),
      agentId: state.agentId,
      modelRef,
      useUtilityModel: true,
    }));
    let reusable = false;
    try {
      const prepared = await preparedPromise;
      reusable = !prepared.agentHarnessRuntimeOverride;
      return prepared;
    } finally {
      // Share pending work and successful native routes. Failed or borrowed routes
      // re-prepare next digest so newly available credentials can restore HTTP.
      if (!reusable && state.preparedPromise === preparedPromise) {
        state.preparedPromise = undefined;
      }
    }
  };

  return async (state: SessionObserverState, notes: readonly string[]) => {
    const controller = new AbortController();
    state.activeController = controller;
    const timeout = setTimeout(() => controller.abort(), SESSION_OBSERVER_MODEL_TIMEOUT_MS);
    const ownedWork = new AsyncWorkScope();
    try {
      const execute = async () => {
        const prepared = await ensurePrepared(state);
        let lastRejectedText = "";
        for (let attempt = 0; attempt < 2; attempt += 1) {
          if (!params.isCurrent(state) || controller.signal.aborted) {
            throw new Error("session observer state is no longer active");
          }
          const result = await params.completeModel({
            ...prepared,
            purpose: "session-observer",
            config: params.getConfig(),
            systemPrompt: SESSION_OBSERVER_SYSTEM_PROMPT,
            prompt: buildSessionObserverPrompt(state, notes),
            timeoutMs: SESSION_OBSERVER_MODEL_TIMEOUT_MS,
            abortSignal: controller.signal,
            answerTokenBudget: 300,
            streamParams: { temperature: 0.2 },
          });
          const parsed = normalizeSessionObserverModelOutput(result.text);
          if (parsed) {
            return parsed;
          }
          lastRejectedText = result.text;
        }
        const prefix = sanitizeSessionObserverModelText(
          redactToolPayloadText(lastRejectedText),
          REJECTED_OUTPUT_MAX_CHARS,
        );
        throw new Error(
          `session observer returned invalid JSON twice; last rejected output: ${prefix}`,
        );
      };
      return await racePromiseWithAbortSignal(
        ownedWork.track(execute),
        controller.signal,
        () => new Error("session observer model call timed out or was cancelled"),
      );
    } finally {
      clearTimeout(timeout);
      // A logical result can precede tracked cleanup. Join this digest's scope,
      // never the shared parent that is itself waiting for this completion.
      await AsyncWorkScope.runWhenAllIdle(
        () => [ownedWork],
        () => ownedWork.drain(),
      );
      if (state.activeController === controller) {
        state.activeController = undefined;
      }
    }
  };
}
