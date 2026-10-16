import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { redactToolPayloadText } from "../logging/redact.js";
import {
  buildSessionObserverPrompt,
  normalizeSessionObserverModelOutput,
  sanitizeSessionObserverModelText,
  SESSION_OBSERVER_SYSTEM_PROMPT,
} from "./session-observer-model.js";
import type { SessionObserverDeps, SessionObserverState } from "./session-observer-model.js";

// CLI-backed utility models (for example claude-cli Haiku) take 9-16s per call.
const SESSION_OBSERVER_MODEL_TIMEOUT_MS = 30_000;
const REJECTED_OUTPUT_MAX_CHARS = 160;

type PrepareModel = NonNullable<SessionObserverDeps["prepareModel"]>;
type CompleteModel = NonNullable<SessionObserverDeps["completeModel"]>;

export function createSessionObserverCompletion(params: {
  getConfig: SessionObserverDeps["getConfig"];
  prepareModel: PrepareModel;
  completeModel: CompleteModel;
  setTimeoutFn: typeof setTimeout;
  clearTimeoutFn: typeof clearTimeout;
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
    const timeout = params.setTimeoutFn(
      () => controller.abort(),
      SESSION_OBSERVER_MODEL_TIMEOUT_MS,
    );
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
        execute(),
        controller.signal,
        () => new Error("session observer model call timed out or was cancelled"),
      );
    } finally {
      params.clearTimeoutFn(timeout);
      if (state.activeController === controller) {
        state.activeController = undefined;
      }
    }
  };
}
