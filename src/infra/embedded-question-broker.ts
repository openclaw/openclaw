import { GatewayClientRequestError } from "../../packages/gateway-client/src/request-error.js";
import {
  type QuestionGetResult,
  type QuestionListResult,
  type QuestionRequestedEvent,
  type QuestionRequestResult,
  type QuestionResolvedEvent,
  type QuestionResolveResult,
  type QuestionWaitAnswerResult,
  validateQuestionGetParams,
  validateQuestionListParams,
  validateQuestionRequestParams,
  validateQuestionResolveParams,
  validateQuestionWaitAnswerParams,
} from "../../packages/gateway-protocol/src/index.js";
import { registerActiveEmbeddedRunHumanInputWait } from "../agents/embedded-agent-runner/run-state.js";
import { getGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import {
  QuestionManager,
  QuestionManagerError,
  QuestionManagerErrorCodes,
} from "../gateway/question-manager.js";
import { notifyListeners } from "../shared/listeners.js";
import { racePromiseWithAbortSignal } from "./abort-signal.js";
import {
  getActiveAgentRunDelegatedAuthority,
  registerAgentRunDelegatedAuthorityClosedHandler,
  validateAgentRunDelegatedAuthority,
} from "./agent-run-registry.js";

const EMBEDDED_SECRET_STORE_REQUEST_BLOCKER =
  "Secret store requests need a running Gateway; ask the operator to run `openclaw secrets store` or use the Control UI.";

type QuestionEvent =
  | { event: "question.requested"; payload: QuestionRequestedEvent }
  | { event: "question.resolved"; payload: QuestionResolvedEvent };

let activeBroker: EmbeddedQuestionBroker | null = null;

function invalidRequest(message: string): GatewayClientRequestError {
  return new GatewayClientRequestError({ code: "INVALID_REQUEST", message });
}

/** Serves the question RPC contract for one embedded backend lifetime. */
export class EmbeddedQuestionBroker {
  private readonly manager = new QuestionManager();
  private readonly listeners = new Set<(event: QuestionEvent) => void>();
  private stopped = false;
  private readonly removeAuthorityListener = registerAgentRunDelegatedAuthorityClosedHandler(() => {
    this.manager.cancelClosedAuthorities();
  });

  subscribe(listener: (event: QuestionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  request(params: unknown, signal?: AbortSignal): QuestionRequestResult {
    signal?.throwIfAborted();
    if (this.stopped) {
      throw new Error("Embedded question broker is stopped");
    }
    if (!validateQuestionRequestParams(params)) {
      throw invalidRequest("Invalid question.request params");
    }
    if (params.questions.some((question) => question.secretStore)) {
      // The Gateway owns admitted-run checks, atomic storage, and runtime refresh.
      // A local prompt must not collect a value it cannot safely commit there.
      throw invalidRequest(EMBEDDED_SECRET_STORE_REQUEST_BLOCKER);
    }
    const ids = new Set<string>();
    for (const question of params.questions) {
      if (ids.has(question.questionId)) {
        throw invalidRequest(`duplicate question id '${question.questionId}'`);
      }
      ids.add(question.questionId);
      if (question.options.length === 1) {
        throw invalidRequest(
          `question '${question.questionId}' must have either no options or 2 to 4 options`,
        );
      }
      const labels = new Set<string>();
      for (const option of question.options) {
        const label = option.label.trim().toLowerCase();
        if (labels.has(label)) {
          throw invalidRequest(`question '${question.questionId}' has duplicate option labels`);
        }
        labels.add(label);
      }
    }
    const caller = getGatewayToolCallerIdentity();
    const authority =
      caller?.approvalAuthority ??
      (caller?.operationalRunInstance
        ? getActiveAgentRunDelegatedAuthority(caller.operationalRunInstance)
        : undefined);
    const isRequesterActive = () => {
      try {
        return (
          !signal?.aborted &&
          !caller?.approvalSignals?.some((inputSignal) => inputSignal.aborted) &&
          (!caller?.operationalRunInstance || authority !== undefined) &&
          (!authority || validateAgentRunDelegatedAuthority(authority)) &&
          caller?.approvalAuthorityCheck?.() !== false &&
          caller?.receiptAuthority?.() !== false
        );
      } catch {
        return false;
      }
    };
    const abort = () => {
      this.manager.get(record.id);
    };
    const record = this.manager.request({
      ...structuredClone(params),
      ...(caller
        ? {
            agentId: caller.agentId,
            sessionKey: caller.sessionKey,
            ...(caller.operationalRunInstance
              ? { runId: caller.operationalRunInstance.runId }
              : {}),
          }
        : {}),
      timeoutMs: params.timeoutMs ?? 15 * 60 * 1_000,
      isRequesterActive,
      registerHumanInputWait: authority
        ? (isPending) => registerActiveEmbeddedRunHumanInputWait(authority, isPending)
        : undefined,
      onResolved: (event) => {
        signal?.removeEventListener("abort", abort);
        this.emit({ event: "question.resolved", payload: event });
      },
    });
    signal?.addEventListener("abort", abort, { once: true });
    this.emit({ event: "question.requested", payload: record });
    return { id: record.id, expiresAtMs: record.expiresAtMs };
  }

  async waitAnswer(params: unknown, signal?: AbortSignal): Promise<QuestionWaitAnswerResult> {
    signal?.throwIfAborted();
    if (!validateQuestionWaitAnswerParams(params)) {
      throw invalidRequest("Invalid question.waitAnswer params");
    }
    return await racePromiseWithAbortSignal(
      this.manager.waitAnswer(params.id, params.timeoutMs, params.includeResolutionId),
      signal,
    );
  }

  resolve(params: unknown): QuestionResolveResult {
    if (!validateQuestionResolveParams(params)) {
      throw invalidRequest("Invalid question.resolve params");
    }
    if ("cancel" in params) {
      return this.manager.cancel(params.id, params.resolvedBy);
    }
    if (params.secretStoreAllowedHosts !== undefined) {
      throw invalidRequest("Secret store allowed hosts require a store-bound question.");
    }
    return this.manager.resolve(params.id, params.answers, params.resolvedBy, {
      resolutionId: params.resolutionId,
    });
  }

  get(params: unknown): QuestionGetResult {
    if (!validateQuestionGetParams(params)) {
      throw invalidRequest("Invalid question.get params");
    }
    const question = this.manager.get(params.id);
    if (!question) {
      throw new QuestionManagerError(
        QuestionManagerErrorCodes.NOT_FOUND,
        `question '${params.id}' was not found`,
      );
    }
    return { question };
  }

  list(params: unknown = {}): QuestionListResult {
    if (!validateQuestionListParams(params)) {
      throw invalidRequest("Invalid question.list params");
    }
    return { questions: this.manager.list() };
  }

  async call(method: string, params?: unknown, extra?: { signal?: AbortSignal }): Promise<unknown> {
    extra?.signal?.throwIfAborted();
    try {
      switch (method) {
        case "question.request":
          return this.request(params, extra?.signal);
        case "question.waitAnswer":
          return await this.waitAnswer(params, extra?.signal);
        case "question.resolve":
          return this.resolve(params);
        case "question.get":
          return this.get(params);
        case "question.list":
          return this.list(params);
        default:
          throw invalidRequest(`Unsupported embedded question method: ${method}`);
      }
    } catch (error) {
      if (error instanceof QuestionManagerError) {
        // Shared tool cancellation/recovery reads these protocol error reasons.
        throw new GatewayClientRequestError({
          code: "INVALID_REQUEST",
          message: error.message,
          details: { reason: error.code },
        });
      }
      throw error;
    }
  }

  stop(): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.removeAuthorityListener();
    for (const question of this.manager.list()) {
      this.manager.cancel(question.id, "tui:embedded:stopped");
    }
    this.manager.close();
    this.listeners.clear();
  }

  private emit(event: QuestionEvent): void {
    notifyListeners(this.listeners, event);
  }
}

export function setEmbeddedQuestionBroker(broker: EmbeddedQuestionBroker | null): void {
  activeBroker = broker;
}

export function clearEmbeddedQuestionBroker(broker: EmbeddedQuestionBroker): void {
  if (activeBroker === broker) {
    activeBroker = null;
  }
}

export function getEmbeddedQuestionBroker(): EmbeddedQuestionBroker | null {
  return activeBroker;
}
