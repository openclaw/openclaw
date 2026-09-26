import { normalizeCodexResponsesBaseUrlForOpenAISdk } from "@openclaw/ai/transports";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { TSchema } from "typebox";
import type {
  WorkerInferenceContext,
  WorkerInferenceEventParams,
  WorkerInferenceStartParams,
} from "../../../packages/gateway-protocol/src/schema/worker-inference.js";
import { resolveAgentDir, resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { resolveSessionAuthSelection } from "../../agents/auth-profiles/session-override.js";
import { applyExtraParamsToAgent } from "../../agents/embedded-agent-runner/extra-params.js";
import { wrapStreamFnWithDiagnosticModelCallEvents } from "../../agents/embedded-agent-runner/run/attempt.model-diagnostic-events.js";
import { resolveEmbeddedAgentStream } from "../../agents/embedded-agent-runner/stream-resolution.js";
import { mapThinkingLevel } from "../../agents/embedded-agent-runner/utils.js";
import { resolveAgentHarnessPolicy } from "../../agents/harness/policy.js";
import { splitTrailingAuthProfile } from "../../agents/model-ref-profile.js";
import {
  buildModelAliasIndex,
  normalizeProviderId,
  resolveDefaultModelForAgent,
  resolveModelRefFromString,
} from "../../agents/model-selection.js";
import {
  createModelVisibilityPolicy,
  RUNTIME_MODEL_VISIBILITY_NORMALIZATION,
} from "../../agents/model-visibility-policy.js";
import { resolveModelCatalogIdentityKey } from "../../agents/openai-model-routes.js";
import {
  acquireAgentRunPreparedModelRuntime,
  type PreparedModelRuntimeSnapshot,
} from "../../agents/prepared-model-runtime.js";
import { projectProviderModelRouteConfig } from "../../agents/provider-model-route.js";
import { registerProviderStreamForModel } from "../../agents/provider-stream.js";
import type { BoundAgentRunSessionTarget } from "../../agents/run-session-target.types.js";
import { prepareSimpleCompletionModel } from "../../agents/simple-completion-runtime.js";
import { normalizeUsage, hasObservedModelUsage } from "../../agents/usage.js";
import { getRuntimeConfig } from "../../config/config.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { emitAgentEventForRunContext } from "../../infra/agent-events.js";
import { getAgentRunContext } from "../../infra/agent-run-registry.js";
import { emitTrustedDiagnosticEvent, isDiagnosticsEnabled } from "../../infra/diagnostic-events.js";
import { resolveDiagnosticModelContentCapturePolicy } from "../../infra/diagnostic-llm-content.js";
import {
  createDiagnosticTraceContextFromActiveScope,
  freezeDiagnosticTraceContext,
  type DiagnosticTraceContext,
} from "../../infra/diagnostic-trace-context.js";
import { getModelLlmRuntime } from "../../llm/model-runtime-binding.js";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
  SimpleStreamOptions,
  Tool,
  Usage,
} from "../../llm/types.js";
import { resolveProviderModelRoutes } from "../../plugins/provider-model-routes.js";
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
import { boundedWorkerError, formatWorkerInferenceError } from "./worker-error.js";

type WorkerInferenceStreamEvent = WorkerInferenceEventParams["event"];
type WorkerInferenceSessionTarget = BoundAgentRunSessionTarget & { sessionEntry: SessionEntry };
export type WorkerInferenceExecutor = import("./inference.js").WorkerInferenceExecutor;
export type WorkerInferenceExecutionParams = Parameters<WorkerInferenceExecutor>[0];

type WorkerInferenceUsageParams = {
  config: OpenClawConfig;
  target: WorkerInferenceSessionTarget;
  request: WorkerInferenceStartParams;
  model: Model;
  usage: Usage;
  durationMs: number;
  trace: DiagnosticTraceContext;
};

function copyTool(tool: NonNullable<WorkerInferenceContext["tools"]>[number]): Tool | undefined {
  if (!isRecord(tool.parameters) || tool.parameters.type !== "object") {
    return undefined;
  }
  return {
    name: tool.name,
    description: tool.description,
    parameters: structuredClone(tool.parameters) as TSchema,
  };
}

function buildContext(context: WorkerInferenceContext): Context | undefined {
  const tools: Tool[] = [];
  for (const tool of context.tools ?? []) {
    const copied = copyTool(tool);
    if (!copied) {
      return undefined;
    }
    tools.push(copied);
  }
  return {
    ...(context.systemPrompt !== undefined ? { systemPrompt: context.systemPrompt } : {}),
    // Clone so provider mutation cannot touch the request.
    messages: structuredClone(context.messages) as Context["messages"],
    ...(tools.length > 0 ? { tools } : {}),
  };
}

function optionBudgetsFitModel(
  options: WorkerInferenceStartParams["options"],
  model: Model,
): boolean {
  if (options.maxTokens !== undefined && options.maxTokens > model.maxTokens) {
    return false;
  }
  for (const budget of Object.values(options.thinkingBudgets ?? {})) {
    if (budget !== undefined && budget > model.maxTokens) {
      return false;
    }
  }
  return true;
}

function buildStreamOptions(params: {
  request: WorkerInferenceStartParams;
  signal: AbortSignal;
  apiKey?: string;
}): SimpleStreamOptions {
  const options = params.request.options;
  return {
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
    ...(options.reasoning !== undefined ? { reasoning: mapThinkingLevel(options.reasoning) } : {}),
    ...(options.thinkingBudgets ? { thinkingBudgets: { ...options.thinkingBudgets } } : {}),
    signal: params.signal,
    sessionId: params.request.sessionId,
    ...(params.apiKey ? { apiKey: params.apiKey } : {}),
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
    case "text_end": {
      const content = event.partial.content[event.contentIndex];
      return {
        type: event.type,
        contentIndex: event.contentIndex,
        ...(content?.type === "text" && content.textSignature
          ? { contentSignature: content.textSignature }
          : {}),
      };
    }
    case "thinking_start":
      return { type: "thinking_start", contentIndex: event.contentIndex };
    case "text_delta":
    case "thinking_delta":
      return { type: event.type, contentIndex: event.contentIndex, delta: event.delta };
    case "thinking_end": {
      const content = event.partial.content[event.contentIndex];
      return {
        type: "thinking_end",
        contentIndex: event.contentIndex,
        ...(content?.type === "thinking" && content.thinkingSignature
          ? { contentSignature: content.thinkingSignature }
          : {}),
      };
    }
    case "toolcall_start":
    case "toolcall_delta":
    case "toolcall_end":
    case "done":
    case "error":
      return undefined;
  }
  return undefined;
}

function emitWorkerInferenceUsage(params: WorkerInferenceUsageParams): void {
  if (!isDiagnosticsEnabled(params.config)) {
    return;
  }
  const usage = normalizeUsage(params.usage);
  if (!hasObservedModelUsage(usage)) {
    return;
  }
  const input = usage.input ?? 0;
  const output = usage.output ?? 0;
  const cacheRead = usage.cacheRead ?? 0;
  const cacheWrite = usage.cacheWrite ?? 0;
  const promptTokens = input + cacheRead + cacheWrite;
  const total = usage.total ?? promptTokens + output;
  const costUsd =
    usage.cost?.total ??
    estimateUsageCost({
      usage,
      cost: resolveModelCostConfig({
        provider: params.model.provider,
        model: params.model.id,
        config: params.config,
      }),
    });
  emitTrustedDiagnosticEvent({
    type: "model.usage",
    trace: freezeDiagnosticTraceContext(params.trace),
    sessionKey: params.target.sessionKey,
    sessionId: params.request.sessionId,
    channel: "worker",
    agentId: params.target.agentId,
    provider: params.model.provider,
    model: params.model.id,
    usage: {
      input,
      output,
      cacheRead,
      cacheWrite,
      promptTokens,
      total,
    },
    context: {
      limit: params.model.contextTokens ?? params.model.contextWindow,
      ...(usage.contextUsage?.state === "available"
        ? { used: usage.contextUsage.promptTokens }
        : {}),
    },
    ...(costUsd !== undefined ? { costUsd } : {}),
    durationMs: params.durationMs,
  });
}

async function resolveApprovedModel(params: {
  target: WorkerInferenceSessionTarget;
  request: WorkerInferenceStartParams;
  signal: AbortSignal;
  runtimeSnapshot: PreparedModelRuntimeSnapshot;
  assertCurrent: () => void;
}): Promise<
  | {
      provider: string;
      model: string;
      config: OpenClawConfig;
      agentDir: string;
      workspaceDir: string;
      prepared: Awaited<ReturnType<typeof prepareSimpleCompletionModel>>;
    }
  | undefined
> {
  const { target, request, signal, runtimeSnapshot } = params;
  return await withPluginRuntimeGenerationScope(runtimeSnapshot, async () => {
    const lifecycleConfig = runtimeSnapshot.config;
    const agentDir = runtimeSnapshot.agentDir;
    const workspaceDir =
      runtimeSnapshot.workspaceDir ?? resolveAgentWorkspaceDir(lifecycleConfig, target.agentId);
    const manifestSnapshot = runtimeSnapshot.metadataSnapshot;
    const defaultModel = resolveDefaultModelForAgent({
      cfg: lifecycleConfig,
      agentId: target.agentId,
      manifestPlugins: manifestSnapshot,
      ...RUNTIME_MODEL_VISIBILITY_NORMALIZATION,
    });
    const aliasIndex = buildModelAliasIndex({
      cfg: lifecycleConfig,
      agentId: target.agentId,
      defaultProvider: defaultModel.provider,
      manifestPlugins: manifestSnapshot,
      ...RUNTIME_MODEL_VISIBILITY_NORMALIZATION,
    });
    const resolved = resolveModelRefFromString({
      cfg: lifecycleConfig,
      agentId: target.agentId,
      raw: `${request.modelRef.provider}/${request.modelRef.model}`,
      defaultProvider: defaultModel.provider,
      aliasIndex,
      manifestPlugins: manifestSnapshot,
      ...RUNTIME_MODEL_VISIBILITY_NORMALIZATION,
    });
    if (
      !resolved ||
      normalizeProviderId(resolved.ref.provider) !== normalizeProviderId(request.modelRef.provider)
    ) {
      return undefined;
    }
    const policy = createModelVisibilityPolicy({
      cfg: lifecycleConfig,
      catalog: runtimeSnapshot.modelCatalog.entries,
      defaultProvider: defaultModel.provider,
      defaultModel,
      agentId: target.agentId,
      manifestPlugins: manifestSnapshot,
      ...RUNTIME_MODEL_VISIBILITY_NORMALIZATION,
    });
    const resolvedKey = resolveModelCatalogIdentityKey({
      provider: resolved.ref.provider,
      id: resolved.ref.model,
    });
    // Retained refs stay approved during cold discovery.
    const known =
      policy.allowedCatalog.some(
        (entry) => resolvedKey === resolveModelCatalogIdentityKey(entry),
      ) || policy.retainedKeys.has(resolvedKey);
    if (!known || !policy.allows(resolved.ref)) {
      return undefined;
    }
    const harnessPolicy = resolveAgentHarnessPolicy({
      provider: resolved.ref.provider,
      modelId: resolved.ref.model,
      config: lifecycleConfig,
      agentId: target.agentId,
      sessionKey: target.sessionKey,
    });
    const agentRuntimeId =
      harnessPolicy.runtimeSource !== "implicit" ||
      lifecycleConfig.plugins?.entries?.codex?.enabled === true
        ? harnessPolicy.runtime
        : undefined;
    const sessionSelection = await resolveSessionAuthSelection({
      cfg: lifecycleConfig,
      provider: resolved.ref.provider,
      modelId: resolved.ref.model,
      agentId: target.agentId,
      harnessRuntime: harnessPolicy.runtime,
      agentDir,
      sessionEntry: target.sessionEntry,
      sessionStore: { [target.sessionKey]: target.sessionEntry },
      sessionKey: target.sessionKey,
      storePath: target.storePath,
      assertCommitAllowed: params.assertCurrent,
      isNewSession: false,
    });
    const selectedProfileId = sessionSelection?.profileId;
    const routeRequirement = sessionSelection?.routeRequirement;
    let modelConfig = lifecycleConfig;
    const routeResolution = routeRequirement
      ? resolveProviderModelRoutes({
          provider: resolved.ref.provider,
          modelId: resolved.ref.model,
          config: lifecycleConfig,
        })
      : undefined;
    const route =
      routeResolution?.kind === "routes"
        ? routeResolution.routes.find((candidate) => candidate.authRequirement === routeRequirement)
        : undefined;
    if (route) {
      // Worker placement owns the agent harness, while the gateway-owned profile
      // owns the provider route. Keep those decisions separate or OAuth can be
      // materialized as a public API-key endpoint and fail before the first token.
      modelConfig = projectProviderModelRouteConfig({
        provider: resolved.ref.provider,
        config: lifecycleConfig,
        route,
      });
    }
    // Route projection and credential selection are one decision. Pin even an
    // automatic profile so generic auth fallback cannot cross to another route.
    const prepared = await prepareSimpleCompletionModel({
      cfg: modelConfig,
      agentId: target.agentId,
      provider: resolved.ref.provider,
      modelId: resolved.ref.model,
      agentDir,
      modelIdSource: "selected",
      ...(selectedProfileId ? { profileId: selectedProfileId } : {}),
      ...(selectedProfileId ? { preferredProfile: selectedProfileId } : {}),
      ...(selectedProfileId ? { bindAuthOwner: true } : {}),
      allowMissingApiKeyModes: ["aws-sdk"],
      allowBundledStaticCatalogFallback: true,
      signal,
      preparedModelRuntime: runtimeSnapshot,
      workspaceDir,
      ...(agentRuntimeId ? { agentRuntimeId } : {}),
    });
    return {
      provider: resolved.ref.provider,
      model: resolved.ref.model,
      config: lifecycleConfig,
      agentDir,
      workspaceDir,
      prepared,
    };
  });
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
  const config = params.config ?? getRuntimeConfig();
  const sessionEntry = loadSessionEntry(params.sessionTarget);
  if (sessionEntry?.sessionId !== request.sessionId) {
    return inferenceError("session-not-attached");
  }
  const target = { ...params.sessionTarget, sessionEntry };
  const runContext = getAgentRunContext(request.runId);
  const context = buildContext(request.context);
  if (!context) {
    return inferenceError("invalid-context");
  }
  if (splitTrailingAuthProfile(`${request.modelRef.provider}/${request.modelRef.model}`).profile) {
    return inferenceError("model-not-approved");
  }
  await using runtimeLease = await acquireAgentRunPreparedModelRuntime({
    config,
    agentId: target.agentId,
    agentDir: resolveAgentDir(config, target.agentId),
  });
  const approved = await resolveApprovedModel({
    target,
    request,
    signal,
    runtimeSnapshot: runtimeLease.snapshot,
    assertCurrent: () => {
      signal.throwIfAborted();
      if (!params.isCurrent()) {
        throw new Error("Worker inference source is no longer current");
      }
    },
  });
  if (!approved) {
    return inferenceError("model-not-approved");
  }
  return await withPluginRuntimeGenerationScope(runtimeLease.snapshot, async () => {
    if ("error" in approved.prepared) {
      return inferenceError(
        "provider-error",
        undefined,
        boundedWorkerError(approved.prepared.error, 256),
      );
    }
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
    applyExtraParamsToAgent(
      streamAgent,
      approved.config,
      approved.provider,
      approved.model,
      streamPolicyOptions,
      streamPolicyOptions.reasoning,
      target.agentId,
      approved.workspaceDir,
      providerModel,
      approved.agentDir,
    );
    const scopedStream = streamAgent.streamFn;
    const model = providerModel;
    if (!optionBudgetsFitModel(request.options, model)) {
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
      contentCapture: resolveDiagnosticModelContentCapturePolicy(
        approved.config,
        target.sessionKey,
      ),
      nextCallId: () => `${request.runId}:${request.turnId}:worker-model:${(modelCallSeq += 1)}`,
    });
    let usageRecorded = false;
    const recordUsage = (usage: Usage) => {
      if (usageRecorded) {
        return;
      }
      usageRecorded = true;
      emitWorkerInferenceUsage({
        config: approved.config,
        target,
        request,
        model,
        usage,
        durationMs: Math.max(0, Date.now() - startedAt),
        trace,
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
    try {
      const events = await stream(
        model,
        context,
        buildStreamOptions({
          request,
          signal: providerSignal,
          apiKey: authValue,
        }),
      );
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
