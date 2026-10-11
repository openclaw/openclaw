import { normalizeCodexResponsesBaseUrlForOpenAISdk } from "@openclaw/ai/transports";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { TSchema } from "typebox";
import type {
  WorkerInferenceContext,
  WorkerInferenceEventParams,
  WorkerInferenceStartParams,
} from "../../../packages/gateway-protocol/src/schema/worker-inference.js";
import { applyExtraParamsToAgent } from "../../agents/embedded-agent-runner/extra-params.js";
import { wrapStreamFnWithDiagnosticModelCallEvents } from "../../agents/embedded-agent-runner/run/attempt.model-diagnostic-events.js";
import { applyRuntimeContextCarrierRetention } from "../../agents/embedded-agent-runner/run/runtime-context-prompt.js";
import { resolveSessionBoundaryPromptCacheKey } from "../../agents/embedded-agent-runner/run/session-boundary-prompt-cache-key.js";
import { resolveEmbeddedAgentStream } from "../../agents/embedded-agent-runner/stream-resolution.js";
import { mapThinkingLevel } from "../../agents/embedded-agent-runner/utils.js";
import { resolveFastModeForElapsed, resolveFastModeState } from "../../agents/fast-mode.js";
import { splitTrailingAuthProfile } from "../../agents/model-ref-profile.js";
import { registerProviderStreamForModel } from "../../agents/provider-stream.js";
import { normalizeUsage, hasObservedModelUsage, toDiagnosticUsage } from "../../agents/usage.js";
import { emitAgentEventForRunContext } from "../../infra/agent-events.js";
import { getAgentRunContext } from "../../infra/agent-run-registry.js";
import { emitTrustedDiagnosticEvent, isDiagnosticsEnabled } from "../../infra/diagnostic-events.js";
import { resolveDiagnosticModelContentCapturePolicy } from "../../infra/diagnostic-llm-content.js";
import {
  createDiagnosticTraceContextFromActiveScope,
  freezeDiagnosticTraceContext,
} from "../../infra/diagnostic-trace-context.js";
import { getModelLlmRuntime } from "../../llm/model-runtime-binding.js";
import { createOpenAIServiceTierObservationWrapper } from "../../llm/providers/stream-wrappers/openai-service-tier-observation.js";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Tool,
  Usage,
} from "../../llm/types.js";
import { withPluginRuntimeGenerationScope } from "../../plugins/runtime/generation-scope.js";
import { estimateUsageCost, resolveModelCostConfig } from "../../utils/usage-format.js";
import { WORKER_PROVIDER_REPLAY_LOCAL_RETRY_MESSAGE } from "../../worker/transcript-message.js";
import {
  ERROR_MESSAGES,
  inferenceError,
  projectWorkerInferenceTerminalMessage,
  type WorkerInferenceModelIdentity,
} from "./inference-terminal-message.js";
import { createWorkerToolCallStream } from "./inference-tool-call-stream.js";
import {
  getWorkerTurnToolSurface,
  getWorkerTurnInference,
  readWorkerTurnPromptCacheContext,
} from "./placement-turn-claim-events.js";
import { formatWorkerInferenceError } from "./worker-error.js";

type WorkerInferenceStreamEvent = WorkerInferenceEventParams["event"];
export type WorkerInferenceExecutor = import("./inference.js").WorkerInferenceExecutor;
export type WorkerInferenceExecutionParams = Parameters<WorkerInferenceExecutor>[0];

function buildContext(context: WorkerInferenceContext): Context | undefined {
  const tools: Tool[] = [];
  for (const tool of context.tools ?? []) {
    if (!isRecord(tool.parameters) || tool.parameters.type !== "object") {
      return undefined;
    }
    tools.push({
      name: tool.name,
      description: tool.description,
      parameters: structuredClone(tool.parameters) as TSchema,
    });
  }
  return {
    ...(context.systemPrompt !== undefined ? { systemPrompt: context.systemPrompt } : {}),
    // Clone so provider mutation cannot touch the request.
    messages: structuredClone(context.messages) as Context["messages"],
    ...(tools.length > 0 ? { tools } : {}),
  };
}

function toWorkerStreamEvent(
  event: AssistantMessageEvent,
  modelIdentity: WorkerInferenceModelIdentity,
): WorkerInferenceStreamEvent | undefined {
  switch (event.type) {
    case "start":
      return {
        type: "start",
        resolvedModel: {
          api: modelIdentity.api,
          provider: modelIdentity.provider,
          model: modelIdentity.model,
        },
        timestamp: event.partial.timestamp,
      };
    case "text_start":
    case "text_end":
    case "thinking_end": {
      const content = event.partial.content[event.contentIndex];
      const signature =
        event.type === "thinking_end"
          ? content?.type === "thinking" && content.thinkingSignature
          : content?.type === "text" && content.textSignature;
      return {
        type: event.type,
        contentIndex: event.contentIndex,
        ...(signature ? { contentSignature: signature } : {}),
      };
    }
    case "thinking_start":
      return { type: "thinking_start", contentIndex: event.contentIndex };
    case "text_delta":
    case "thinking_delta":
      return { type: event.type, contentIndex: event.contentIndex, delta: event.delta };
    case "toolcall_start":
    case "toolcall_delta":
    case "toolcall_end":
    case "done":
    case "error":
      return undefined;
  }
  return undefined;
}

export const executeWorkerInference: WorkerInferenceExecutor = async (params) => {
  const { identity, request, signal } = params;
  if (identity.sessionId !== request.sessionId) {
    return inferenceError("session-not-attached");
  }
  if (identity.ownerEpoch !== request.runEpoch) {
    return inferenceError("epoch-mismatch");
  }
  if (signal.aborted || !params.isCurrent()) {
    return inferenceError("cancelled");
  }
  const promptCacheContext = readWorkerTurnPromptCacheContext(identity);
  const approved = getWorkerTurnInference(identity);
  if (!promptCacheContext || !approved) {
    return inferenceError("session-not-attached");
  }
  const runContext = getAgentRunContext(request.runId);
  const target = { ...params.sessionTarget, sessionEntry: approved.sessionEntry };
  const context = buildContext(request.context);
  if (!context) {
    return inferenceError("invalid-context");
  }
  if (
    splitTrailingAuthProfile(`${request.modelRef.provider}/${request.modelRef.model}`).profile ||
    request.modelRef.provider !== approved.modelRef.provider ||
    request.modelRef.model !== approved.modelRef.model
  ) {
    return inferenceError("model-not-approved");
  }
  return await withPluginRuntimeGenerationScope(approved.runtimeSnapshot, async () => {
    const prepared = approved.prepared;
    // Keep logical identity separate from transport endpoint encoding.
    const modelIdentity: WorkerInferenceModelIdentity = {
      api: prepared.model.api,
      provider: approved.provider,
      model: approved.model,
    };
    const logicalModel = prepared.model;
    const llmRuntime = getModelLlmRuntime(logicalModel);
    if (!llmRuntime) {
      throw new Error("Prepared worker model has no lifecycle runtime owner");
    }
    const providerModel =
      logicalModel.provider === "openai" && logicalModel.api === "openai-chatgpt-responses"
        ? {
            ...logicalModel,
            baseUrl: normalizeCodexResponsesBaseUrlForOpenAISdk(logicalModel.baseUrl),
          }
        : logicalModel;
    const providerStream = registerProviderStreamForModel({
      model: providerModel,
      cfg: approved.config,
      agentDir: approved.agentDir,
      workspaceDir: approved.workspaceDir,
    });
    const authValue = prepared.auth.apiKey;
    applyRuntimeContextCarrierRetention(
      context.messages,
      approved.transcriptPolicy.appendOnlyRuntimeContext,
    );
    const streamAgent = resolveEmbeddedAgentStream({
      llmRuntime,
      currentStreamFn: llmRuntime.streamSimple,
      ...(providerStream ? { providerStreamFn: providerStream } : {}),
      sessionId: request.sessionId,
      signal,
      model: providerModel,
      resolvedApiKey: authValue,
      authProfileId: prepared.auth.profileId,
    });
    const streamPolicyOptions: WorkerInferenceStartParams["options"] = {
      ...(request.options.temperature !== undefined
        ? { temperature: request.options.temperature }
        : {}),
      ...(request.options.maxTokens !== undefined ? { maxTokens: request.options.maxTokens } : {}),
      ...(request.options.reasoning !== undefined ? { reasoning: request.options.reasoning } : {}),
      ...(request.options.thinkingBudgets
        ? { thinkingBudgets: { ...request.options.thinkingBudgets } }
        : {}),
    };
    const fastMode = resolveFastModeState({
      cfg: approved.config,
      provider: approved.provider,
      model: approved.model,
      agentId: target.agentId,
      sessionEntry: target.sessionEntry,
    });
    const fastModeSetting = promptCacheContext.fastMode ?? fastMode.mode;
    const fastModeStartedAtMs =
      promptCacheContext.fastModeStartedAtMs ??
      runContext?.lifecycleStartedAt ??
      runContext?.registeredAt ??
      Date.now();
    applyExtraParamsToAgent(
      streamAgent,
      approved.config,
      approved.provider,
      approved.model,
      {
        ...structuredClone(streamPolicyOptions),
        fastMode:
          fastModeSetting === "auto"
            ? () =>
                resolveFastModeForElapsed({
                  mode: "auto",
                  startedAtMs: fastModeStartedAtMs,
                  fastAutoOnSeconds:
                    promptCacheContext.fastModeAutoOnSeconds ?? fastMode.fastAutoOnSeconds,
                }).enabled
            : fastModeSetting,
      },
      streamPolicyOptions.reasoning,
      target.agentId,
      approved.workspaceDir,
      providerModel,
      approved.agentDir,
      undefined,
      {
        nativeWebSearchPolicyContext: {
          sessionKey: target.sessionKey,
          webSearchEnabled:
            (await getWorkerTurnToolSurface(identity)?.getSurface(identity))?.tools.some(
              ({ definition }) => definition.name === "web_search",
            ) === true,
        },
      },
    );
    const recordServiceTierObservation = prepared.recordServiceTierObservation;
    const scopedStream = recordServiceTierObservation
      ? createOpenAIServiceTierObservationWrapper(
          streamAgent.streamFn,
          (model, observation) =>
            !signal.aborted &&
            params.isCurrent() &&
            recordServiceTierObservation({
              modelId: model.id,
              runtimeId: "openclaw",
              api: model.api,
              baseUrl: model.baseUrl,
              ...observation,
            }),
        )
      : streamAgent.streamFn;
    const model = providerModel;
    if (
      [request.options.maxTokens, ...Object.values(request.options.thinkingBudgets ?? {})].some(
        (budget) => budget !== undefined && budget > model.maxTokens,
      )
    ) {
      return inferenceError("invalid-context");
    }
    if (signal.aborted || !params.isCurrent()) {
      return inferenceError("cancelled");
    }

    const startedAt = Date.now();
    const trace = createDiagnosticTraceContextFromActiveScope();
    let modelCallSeq = 0;
    const stream = wrapStreamFnWithDiagnosticModelCallEvents(scopedStream, {
      config: approved.config,
      runId: request.runId,
      sessionKey: target.sessionKey,
      sessionId: request.sessionId,
      provider: model.provider,
      model: model.id,
      api: model.api,
      contextTokenBudget: model.contextTokens ?? model.contextWindow,
      trace,
      contentCapture: resolveDiagnosticModelContentCapturePolicy(approved.config),
      nextCallId: () => `${request.runId}:${request.turnId}:worker-model:${(modelCallSeq += 1)}`,
    });
    const recordUsage = (rawUsage: Usage) => {
      const durationMs = Math.max(0, Date.now() - startedAt);
      if (!isDiagnosticsEnabled(approved.config)) {
        return;
      }
      const usage = normalizeUsage(rawUsage);
      if (!hasObservedModelUsage(usage)) {
        return;
      }
      const costUsd =
        usage.cost?.total ??
        estimateUsageCost({
          usage,
          cost: resolveModelCostConfig({
            provider: model.provider,
            model: model.id,
            config: approved.config,
          }),
        });
      emitTrustedDiagnosticEvent({
        type: "model.usage",
        trace: freezeDiagnosticTraceContext(trace),
        sessionKey: target.sessionKey,
        sessionId: request.sessionId,
        channel: "worker",
        agentId: target.agentId,
        provider: model.provider,
        model: model.id,
        usage: toDiagnosticUsage(usage),
        context: {
          limit: model.contextTokens ?? model.contextWindow,
          ...(usage.contextUsage?.state === "available"
            ? { used: usage.contextUsage.promptTokens }
            : {}),
        },
        ...(costUsd !== undefined ? { costUsd } : {}),
        durationMs,
      });
    };
    const executionIsCurrent = () => !signal.aborted && params.isCurrent();
    const toolCalls = createWorkerToolCallStream({
      emit: params.emit,
      isCurrent: executionIsCurrent,
    });

    const providerAbort = new AbortController();
    const providerSignal = AbortSignal.any([signal, providerAbort.signal]);
    let currentMessage: AssistantMessage | undefined;
    let publishedModel: string | undefined;
    const { reasoning, ...streamOptions } = streamPolicyOptions;
    try {
      const events = await stream(model, context, {
        ...streamOptions,
        ...(reasoning !== undefined ? { reasoning: mapThinkingLevel(reasoning) } : {}),
        signal: providerSignal,
        sessionId: request.sessionId,
        ...(authValue ? { apiKey: authValue } : {}),
        promptCacheKey: resolveSessionBoundaryPromptCacheKey({
          ...promptCacheContext,
          api: model.api,
          sessionId: request.sessionId,
        }),
      });
      for await (const event of events) {
        if (event.type !== "error") {
          // Lean text deltas retain the provider's latest mutable checkpoint.
          currentMessage =
            event.type === "done" ? event.message : (event.partial ?? currentMessage);
          const executingModel = currentMessage?.responseModel ?? modelIdentity.model;
          if (
            currentMessage &&
            executingModel !== publishedModel &&
            runContext?.sessionId === request.sessionId &&
            runContext.sessionKey === target.sessionKey &&
            (runContext.agentId === undefined || runContext.agentId === target.agentId) &&
            executionIsCurrent()
          ) {
            emitAgentEventForRunContext(
              {
                runId: request.runId,
                stream: "lifecycle",
                data: { phase: "model", provider: modelIdentity.provider, model: executingModel },
              },
              runContext,
            );
            publishedModel = executingModel;
          }
        }
        if (event.type === "done") {
          recordUsage(event.message.usage);
          if (signal.aborted || !params.isCurrent()) {
            return inferenceError("cancelled", event.message.usage);
          }
          for (const [contentIndex, content] of event.message.content.entries()) {
            if (content.type === "toolCall") {
              const endResult = toolCalls.end(contentIndex, event.message, content);
              if (endResult === "cancelled") {
                return inferenceError("cancelled", event.message.usage);
              }
              if (endResult === "invalid") {
                return inferenceError("provider-error");
              }
            }
          }
          if (!toolCalls.matchesTerminal(event.message)) {
            return inferenceError("provider-error");
          }
          const terminal = projectWorkerInferenceTerminalMessage({
            message: event.message,
            modelIdentity,
            stopReason: event.reason,
          });
          if (terminal.kind === "provider-replay-unavailable") {
            if (isDiagnosticsEnabled(approved.config)) {
              const { bytes, limitBytes, reason } = terminal.details;
              emitTrustedDiagnosticEvent({
                type: "payload.large",
                surface: "worker.provider-replay",
                action: "rejected",
                bytes,
                limitBytes,
                reason,
                trace: freezeDiagnosticTraceContext(trace),
              });
            }
            return inferenceError(
              "provider-error",
              event.message.usage,
              WORKER_PROVIDER_REPLAY_LOCAL_RETRY_MESSAGE,
            );
          }
          return { type: "done", message: terminal.message };
        }
        if (event.type === "error") {
          recordUsage(event.error.usage);
          return inferenceError(
            event.reason === "aborted" ? "cancelled" : "provider-error",
            event.error.usage,
            event.reason === "aborted"
              ? undefined
              : formatWorkerInferenceError({
                  message: event.error.errorMessage ?? ERROR_MESSAGES["provider-error"],
                  errorCode: event.error.errorCode,
                  errorType: event.error.errorType,
                  errorBody: event.error.errorBody,
                }),
          );
        }
        if (signal.aborted || !params.isCurrent()) {
          return inferenceError("cancelled");
        }
        if (event.type === "toolcall_start") {
          if (toolCalls.start(event.contentIndex, event.partial) === "cancelled") {
            return inferenceError("cancelled");
          }
          continue;
        }
        if (event.type === "toolcall_delta" || event.type === "toolcall_end") {
          const result =
            event.type === "toolcall_delta"
              ? toolCalls.delta(event.contentIndex, event.delta, event.partial)
              : toolCalls.end(event.contentIndex, event.partial, event.toolCall);
          if (result === "cancelled") {
            return inferenceError("cancelled");
          }
          if (result === "invalid") {
            return inferenceError("provider-error");
          }
          continue;
        }
        const workerEvent = toWorkerStreamEvent(event, modelIdentity);
        if (workerEvent) {
          params.emit(workerEvent);
        }
      }
      return inferenceError(signal.aborted ? "cancelled" : "provider-error");
    } catch (error) {
      return inferenceError(
        signal.aborted ? "cancelled" : "provider-error",
        undefined,
        signal.aborted ? undefined : formatWorkerInferenceError(error),
      );
    } finally {
      providerAbort.abort();
    }
  });
};
