import type { SessionCompanionExchange } from "../../packages/gateway-protocol/src/schema/sessions.js";
import {
  SESSION_COMPANION_MAX_MS,
  SESSION_COMPANION_SLOW_MS,
} from "../../packages/gateway-protocol/src/session-companion-contract.js";
import type { AdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { isTimeoutError, isFailoverError } from "../agents/failover/error.js";
import type { SessionEntryCreateWithTranscriptOptions } from "../config/sessions/session-accessor.js";
import { composeSessionSourceAssertion } from "../config/sessions/session-source-authority.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveChatAttachmentMaxBytes } from "./chat-attachment-policy.js";
import { parseMessageWithAttachments, type ChatAttachment } from "./chat-attachments.js";
import type { SessionCompanionContextReader } from "./session-companion-context.js";
import { SessionCompanionAskError } from "./session-companion-errors.js";
import {
  buildSessionCompanionSystemPrompt,
  resolveSessionCompanionModel,
  resolveSessionCompanionRoute,
  type SessionCompanionAskSelection,
} from "./session-companion-policy.js";
import {
  buildReferenceContext,
  composePromptMessages,
  formatObserverDigest,
  sanitizeAnswer,
  selectDeltaNotes,
} from "./session-companion-prompt.js";
import {
  runSessionCompanionModel,
  type SessionCompanionRunParams,
} from "./session-companion-run.js";
import {
  sessionCompanionThreadKey,
  trimSessionCompanionExchanges,
  type SessionCompanionThread,
} from "./session-companion-state.js";
import { SessionMutationAuthorizationChangedError } from "./session-mutation-authorization-error.js";
import type { SessionObserverCompanionSnapshot } from "./session-observer-contract.js";

const companionLog = createSubsystemLogger("gateway/session-companion");

const MAX_CONCURRENT_ASKS = 6;
const ASK_RATE_WINDOW_MS = 60_000;
const MAX_ASKS_PER_RATE_WINDOW = 12;
const MAX_ASKS_PER_CONNECTION_RATE_WINDOW = 4;

export type SessionCompanionAskDeps = {
  getConfig: () => OpenClawConfig;
  sessionObserver: {
    getCompanionSnapshotAsync: (
      sessionKey: string,
      agentId?: string,
    ) => Promise<SessionObserverCompanionSnapshot>;
  };
  contextReader: SessionCompanionContextReader;
};

type SessionCompanionAskRuntimeParams = SessionCompanionAskDeps & {
  threads: Map<string, SessionCompanionThread>;
  now: () => number;
  isDisposed: () => boolean;
};

type SessionCompanionCancellationKind =
  | "backing-session-revoked"
  | "disposed"
  | "explicit-reset"
  | "stopped"
  | "request-aborted"
  | "timeout";

type SessionCompanionActiveAsk = {
  askId?: string;
  cancellation?: SessionCompanionCancellationKind;
  controller: AbortController;
};

export function createSessionCompanionAskRuntime(params: SessionCompanionAskRuntimeParams) {
  const contextReader = params.contextReader;
  const activeAsks = new Map<string, SessionCompanionActiveAsk>();
  const admissions: Array<{ connId: string; admittedAt: number }> = [];

  const currentSessionId = (sessionKey: string, agentId: string) =>
    contextReader.currentSessionId({ agentId, sessionKey });

  const prepareThread = async (
    threadKey: string,
    { sessionKey, agentId }: { sessionKey: string; agentId: string },
    signal: AbortSignal,
    assertSourceCurrent?: () => void,
  ): Promise<SessionCompanionThread> => {
    const existing = params.threads.get(threadKey);
    const observerSnapshot = await params.sessionObserver.getCompanionSnapshotAsync(
      sessionKey,
      agentId,
    );
    const existingSessionId = existing ? await currentSessionId(sessionKey, agentId) : undefined;
    if (signal.aborted) {
      throw new Error("session companion preparation was cancelled");
    }
    assertSourceCurrent?.();
    if (existing && existingSessionId === existing.context.sessionId) {
      return existing;
    }
    if (existing) {
      params.threads.delete(threadKey);
    }
    const result = await contextReader.read({ agentId, sessionKey, signal });
    if (signal.aborted || params.isDisposed()) {
      throw new Error("session companion preparation was cancelled");
    }
    assertSourceCurrent?.();
    if (result.kind === "missing") {
      throw new SessionCompanionAskError(
        "session-missing",
        "The selected session is no longer available.",
      );
    }
    if (result.kind === "unavailable") {
      throw new SessionCompanionAskError(
        "context-unavailable",
        "The selected session history could not be loaded.",
      );
    }
    const thread: SessionCompanionThread = {
      context: result.context,
      digestText: formatObserverDigest(observerSnapshot),
      exchanges: [],
      lastNoteSequence: 0,
      busy: false,
      lastUsedAt: params.now(),
    };
    params.threads.set(threadKey, thread);
    return thread;
  };

  const ask = async (request: {
    agentId: string;
    sessionKey: string;
    question: string;
    askId?: string;
    selectionContext?: string;
    attachments?: ChatAttachment[];
    selection?: SessionCompanionAskSelection;
    connId: string;
    ownerId: string;
    operatorAuthority?: AdmittedRunOperatorAuthority;
    assertSourceCurrent?: () => void;
    followRegistration?: SessionEntryCreateWithTranscriptOptions["followRegistration"];
    assertInputCurrent?: () => void;
    signal?: AbortSignal;
  }): Promise<{ answer: string; ts: number }> => {
    const sessionKey = request.sessionKey.trim();
    const agentId = request.agentId.trim();
    const question = request.question.trim();
    if (!sessionKey || !agentId || !question || params.isDisposed() || request.signal?.aborted) {
      throw new SessionCompanionAskError("unavailable", "Side chat is unavailable.");
    }
    const assertSourceCurrent = request.operatorAuthority
      ? composeSessionSourceAssertion([
          request.assertSourceCurrent,
          request.operatorAuthority.assertCurrent,
        ])
      : request.assertSourceCurrent;
    assertSourceCurrent?.();
    const requestSignal = request.operatorAuthority?.signal
      ? request.signal
        ? AbortSignal.any([request.signal, request.operatorAuthority.signal])
        : request.operatorAuthority.signal
      : request.signal;
    const threadKey = sessionCompanionThreadKey(sessionKey, agentId, request.ownerId);
    const existing = params.threads.get(threadKey);
    if (existing?.busy || activeAsks.has(threadKey)) {
      throw new SessionCompanionAskError("busy", "Side chat is answering another question.");
    }
    const admittedAt = params.now();
    const cutoff = admittedAt - ASK_RATE_WINDOW_MS;
    while ((admissions[0]?.admittedAt ?? admittedAt) < cutoff) {
      admissions.shift();
    }
    const connectionAdmissions = admissions.filter(
      (admission) => admission.connId === request.connId,
    );
    const globalRetryAfterMs =
      admissions.length >= MAX_ASKS_PER_RATE_WINDOW
        ? Math.max(1, (admissions[0]?.admittedAt ?? admittedAt) + ASK_RATE_WINDOW_MS - admittedAt)
        : 0;
    const connectionRetryAfterMs =
      connectionAdmissions.length >= MAX_ASKS_PER_CONNECTION_RATE_WINDOW
        ? Math.max(
            1,
            (connectionAdmissions[0]?.admittedAt ?? admittedAt) + ASK_RATE_WINDOW_MS - admittedAt,
          )
        : 0;
    if (
      activeAsks.size >= MAX_CONCURRENT_ASKS ||
      globalRetryAfterMs > 0 ||
      connectionRetryAfterMs > 0
    ) {
      throw new SessionCompanionAskError(
        "rate-limited",
        "Side chat has reached its question limit. Try again shortly.",
        Math.max(
          activeAsks.size >= MAX_CONCURRENT_ASKS ? ASK_RATE_WINDOW_MS : 0,
          globalRetryAfterMs,
          connectionRetryAfterMs,
        ),
      );
    }

    admissions.push({ connId: request.connId, admittedAt });
    const controller = new AbortController();
    const activeAsk: SessionCompanionActiveAsk = { controller, askId: request.askId };
    activeAsks.set(threadKey, activeAsk);
    const abort = (cancellation: SessionCompanionCancellationKind) => {
      if (activeAsks.get(threadKey) !== activeAsk || activeAsk.cancellation) {
        return;
      }
      activeAsk.cancellation = cancellation;
      controller.abort();
    };
    const abortRequest = () => abort("request-aborted");
    if (requestSignal?.aborted) {
      abortRequest();
    } else {
      requestSignal?.addEventListener("abort", abortRequest, { once: true });
    }
    // Once execution starts, the runner owns provider/CLI inactivity. Its watchdog
    // follows actual work; a second wall clock here would kill healthy streams.
    const preparationTimeout = setTimeout(() => abort("timeout"), SESSION_COMPANION_SLOW_MS);
    const timeout = setTimeout(() => abort("timeout"), SESSION_COMPANION_MAX_MS);
    const aborted = createDeferredCore<never>();
    const onAbort = () =>
      aborted.reject(new Error("session companion ask timed out or was cancelled"));
    controller.signal.addEventListener("abort", onAbort, { once: true });
    let ownedThread: SessionCompanionThread | undefined;
    let mustSettleExecution = isIncognitoSessionKey(sessionKey);
    const discardOwnedThread = () => {
      if (ownedThread && params.threads.get(threadKey) === ownedThread) {
        params.threads.delete(threadKey);
      }
    };
    // Preparation shares the model's cancellation race. Late completions must
    // still pass the ownership checks before dispatching or committing an answer.
    const execute = async () => {
      const thread = await prepareThread(
        threadKey,
        { sessionKey, agentId },
        controller.signal,
        assertSourceCurrent,
      );
      ownedThread = thread;
      if (controller.signal.aborted) {
        throw new Error("session companion preparation was cancelled");
      }
      thread.busy = true;
      thread.lastUsedAt = admittedAt;
      const currentSnapshot = await params.sessionObserver.getCompanionSnapshotAsync(
        sessionKey,
        agentId,
      );
      controller.signal.throwIfAborted();
      assertSourceCurrent?.();
      request.assertInputCurrent?.();
      const cfg = params.getConfig();
      const { modelRef, fallbacks } = resolveSessionCompanionRoute(cfg, agentId, request.selection);
      if (!modelRef) {
        throw new SessionCompanionAskError(
          "utility-model-unavailable",
          "No utility model is configured for this session.",
        );
      }
      const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
      thread.digestText = formatObserverDigest(currentSnapshot);
      const delta = selectDeltaNotes(currentSnapshot, thread.lastNoteSequence);
      const referenceContext = buildReferenceContext({
        thread,
        deltaNotes: delta.notes,
      });
      const messages = composePromptMessages({
        thread,
        question,
        selectionContext: request.selectionContext,
        referenceContext,
        now: admittedAt,
      });
      const input = await parseMessageWithAttachments(question, request.attachments, {
        maxBytes: resolveChatAttachmentMaxBytes(cfg),
        acceptNonImage: false,
        imageStorage: "inline",
        signal: controller.signal,
        assertCurrent: () => {
          assertSourceCurrent?.();
          request.assertInputCurrent?.();
        },
      });
      const executionSessionId = await currentSessionId(sessionKey, agentId);
      controller.signal.throwIfAborted();
      assertSourceCurrent?.();
      request.assertInputCurrent?.();
      if (executionSessionId !== thread.context.sessionId) {
        discardOwnedThread();
        throw new SessionCompanionAskError(
          "context-unavailable",
          "The selected session changed before Side chat could answer.",
        );
      }
      const runParams: SessionCompanionRunParams = {
        cfg,
        agentId,
        modelRef,
        ...(request.selection?.controls ? { controls: request.selection.controls } : {}),
        sessionKey,
        workspaceDir,
        systemPrompt: buildSessionCompanionSystemPrompt(sessionKey),
        messages,
        ...(input.images.length ? { images: input.images } : {}),
        ...(request.operatorAuthority ? { operatorAuthority: request.operatorAuthority } : {}),
        assertSourceCurrent,
        followRegistration: request.followRegistration,
        ...(request.assertInputCurrent ? { assertInputCurrent: request.assertInputCurrent } : {}),
        signal: controller.signal,
        onExecutionStarted: () => clearTimeout(preparationTimeout),
      };
      let rawAnswer: string;
      mustSettleExecution = true;
      if (fallbacks.length) {
        // The fallback owner filters the whole chain before choosing a permitted route.
        const selection = resolveSessionCompanionModel({
          ...runParams,
          operatorAuthority: undefined,
        });
        const [{ runWithModelFallback }, { resolveModelCandidateChain }] = await Promise.all([
          import("../agents/model-fallback-runner.js"),
          import("../agents/model-fallback-candidates.js"),
        ]);
        const candidateParams = {
          cfg,
          agentId,
          provider: selection.provider,
          model: selection.modelId,
          requestedRouteResolution: "resolved" as const,
          fallbacksOverride: fallbacks,
        };
        const modelPolicy = request.operatorAuthority?.modelPolicy;
        if (modelPolicy && !resolveModelCandidateChain(candidateParams).some(modelPolicy.allows)) {
          // Preserve Side chat's permitted-model recovery when the entire utility chain is denied.
          rawAnswer = await runSessionCompanionModel(runParams);
        } else {
          const result = await runWithModelFallback({
            ...candidateParams,
            abortSignal: controller.signal,
            operatorAuthority: request.operatorAuthority,
            skipAuthProfileRuntime: true,
            resolveAgentHarnessRuntimeOverride: () => "openclaw",
            run: (provider, model, options) => {
              controller.signal.throwIfAborted();
              assertSourceCurrent?.();
              request.assertInputCurrent?.();
              return runSessionCompanionModel({
                ...runParams,
                modelRef:
                  options?.modelRoutingProvenance.stage === "fallback"
                    ? `${provider}/${model}${
                        provider === selection.provider && selection.profileId
                          ? `@${selection.profileId}`
                          : ""
                      }`
                    : modelRef,
              });
            },
          });
          rawAnswer = result.result;
        }
      } else {
        rawAnswer = await runSessionCompanionModel(runParams);
      }
      const replySessionId = await currentSessionId(sessionKey, agentId);
      if (activeAsk.cancellation || params.isDisposed()) {
        throw new Error("session companion ask was cancelled");
      }
      assertSourceCurrent?.();
      if (params.threads.get(threadKey) !== thread || replySessionId !== thread.context.sessionId) {
        discardOwnedThread();
        throw new SessionCompanionAskError(
          "context-unavailable",
          "The selected session changed before Side chat could answer.",
        );
      }
      const answer = sanitizeAnswer(rawAnswer, question);
      if (!answer) {
        throw new Error("session companion returned an empty answer");
      }
      const ts = params.now();
      const exchange: SessionCompanionExchange = { question, answer, ts };
      thread.exchanges.push(exchange);
      trimSessionCompanionExchanges(thread.exchanges);
      thread.lastNoteSequence = delta.lastSequence;
      thread.lastUsedAt = ts;
      return { answer, ts };
    };
    const execution = execute();
    try {
      return await Promise.race([execution, aborted.promise]);
    } catch (error) {
      if (
        error instanceof SessionCompanionAskError ||
        error instanceof SessionMutationAuthorizationChangedError
      ) {
        throw error;
      }
      if (activeAsk.cancellation === "backing-session-revoked") {
        discardOwnedThread();
        throw new SessionCompanionAskError(
          "context-unavailable",
          "The selected session changed before Side chat could answer.",
        );
      }
      if (activeAsk.cancellation === "stopped") {
        throw new SessionCompanionAskError("stopped", "Side chat answer stopped.");
      }
      const timedOut =
        activeAsk.cancellation === "timeout" ||
        (!activeAsk.cancellation &&
          (isTimeoutError(error) || (isFailoverError(error) && error.reason === "timeout")));
      companionLog.warn("session companion ask failed", { sessionKey, error });
      throw new SessionCompanionAskError(
        timedOut ? "timeout" : "unavailable",
        timedOut
          ? "Side chat timed out. Try again."
          : activeAsk.cancellation === "explicit-reset"
            ? "The Side chat request was cancelled."
            : "Side chat could not answer right now.",
      );
    } finally {
      // Keep RPC source facts and the busy slot until internal-session writes and cleanup
      // settle. Ordinary context reads still time out without waiting for a model run.
      if (mustSettleExecution) {
        await execution.catch(() => undefined);
      }
      clearTimeout(preparationTimeout);
      clearTimeout(timeout);
      controller.signal.removeEventListener("abort", onAbort);
      requestSignal?.removeEventListener("abort", abortRequest);
      if (activeAsks.get(threadKey) === activeAsk) {
        activeAsks.delete(threadKey);
      }
      if (ownedThread && params.threads.get(threadKey) === ownedThread) {
        ownedThread.busy = false;
      }
    }
  };

  return {
    ask,
    activeKeys: () => activeAsks.keys(),
    cancel(
      threadKey: string,
      cancellation: Extract<
        SessionCompanionCancellationKind,
        "backing-session-revoked" | "explicit-reset" | "stopped"
      >,
      askId?: string,
    ) {
      const activeAsk = activeAsks.get(threadKey);
      if (!activeAsk || (cancellation === "stopped" && activeAsk.askId !== askId)) {
        return false;
      }
      if (activeAsk.cancellation) {
        return activeAsk.cancellation === cancellation;
      }
      activeAsk.cancellation = cancellation;
      activeAsk.controller.abort();
      return true;
    },
    dispose() {
      for (const activeAsk of activeAsks.values()) {
        activeAsk.cancellation ??= "disposed";
        activeAsk.controller.abort();
      }
      activeAsks.clear();
      admissions.length = 0;
    },
  };
}
