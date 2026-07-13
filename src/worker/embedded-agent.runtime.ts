import type {
  WorkerLiveEvent,
  WorkerTranscriptMessage,
} from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import { WORKER_TRANSCRIPT_MAX_BATCH_MESSAGES } from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import type {
  WorkerInferenceContext,
  WorkerInferenceModelRef,
  WorkerInferenceOptions,
} from "../../packages/gateway-protocol/src/schema/worker-inference.js";
import { WORKER_INFERENCE_MAX_CONTEXT_MESSAGES } from "../../packages/gateway-protocol/src/schema/worker-inference.js";
import { toToolDefinitions } from "../agents/agent-tool-definition-adapter.js";
import { createOpenClawCodingTools } from "../agents/agent-tools.js";
import { buildBootstrapContextForFiles } from "../agents/bootstrap-files.js";
import { createNativeModelOwnedRuntimeModel } from "../agents/embedded-agent-runner/run/setup.js";
import type { AgentMessage } from "../agents/runtime/index.js";
import { guardSessionManager } from "../agents/session-tool-result-guard-wrapper.js";
import type { AgentSessionEvent } from "../agents/sessions/agent-session.js";
import { AuthStorage } from "../agents/sessions/auth-storage.js";
import { ModelRegistry } from "../agents/sessions/model-registry.js";
import { DefaultResourceLoader } from "../agents/sessions/resource-loader.js";
import { createAgentSession } from "../agents/sessions/sdk.js";
import { SessionManager } from "../agents/sessions/session-manager.js";
import { SettingsManager } from "../agents/sessions/settings-manager.js";
import { DEFAULT_AGENTS_FILENAME, loadWorkspaceBootstrapFiles } from "../agents/workspace.js";
import type {
  AssistantMessage,
  AssistantMessageEventStreamLike,
  Context,
  Message,
} from "../llm/types.js";
import { getProcessSupervisor } from "../process/supervisor/index.js";
import { truncateUtf8Prefix } from "../utils/utf8-truncate.js";
import { isWorkerTranscriptMessageFrameSafe } from "./transcript-message.js";

const LOCAL_WORKER_TOOL_NAMES = [
  "read",
  "write",
  "edit",
  "apply_patch",
  "exec",
  "process",
] as const;
const MAX_LIVE_EVENT_BYTES = 32 * 1024;
const MAX_LIVE_PREVIEW_BYTES = 4 * 1024;

function toError(value: unknown, fallback: string): Error {
  return value instanceof Error ? value : new Error(fallback, { cause: value });
}

function liveEventBytes(event: WorkerLiveEvent): number {
  try {
    return Buffer.byteLength(JSON.stringify(event), "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function truncateLiveText(value: string): string {
  if (Buffer.byteLength(value, "utf8") <= MAX_LIVE_PREVIEW_BYTES) {
    return value;
  }
  const suffix = "…";
  return `${truncateUtf8Prefix(
    value,
    MAX_LIVE_PREVIEW_BYTES - Buffer.byteLength(suffix, "utf8"),
  )}${suffix}`;
}

function boundLiveValue(value: unknown): unknown {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      return null;
    }
    if (Buffer.byteLength(serialized, "utf8") <= MAX_LIVE_PREVIEW_BYTES) {
      return structuredClone(value);
    }
    return { truncated: true, preview: truncateLiveText(serialized) };
  } catch {
    return { truncated: true, preview: "[unserializable live payload]" };
  }
}

function boundLiveEvent(event: WorkerLiveEvent): WorkerLiveEvent {
  if (liveEventBytes(event) <= MAX_LIVE_EVENT_BYTES) {
    return structuredClone(event);
  }
  let bounded: WorkerLiveEvent;
  if (event.kind === "assistant") {
    const text = truncateLiveText(event.payload.text);
    bounded = {
      kind: "assistant",
      payload: {
        ...event.payload,
        text,
        delta: text,
        replace: true,
      },
    };
  } else if (event.kind === "thinking") {
    bounded = {
      kind: "thinking",
      payload: {
        text: truncateLiveText(event.payload.text),
        delta: truncateLiveText(event.payload.delta),
      },
    };
  } else if (event.kind === "tool") {
    if (event.payload.phase === "start") {
      bounded = {
        kind: "tool",
        payload: { ...event.payload, args: boundLiveValue(event.payload.args) },
      };
    } else if (event.payload.phase === "update") {
      bounded = {
        kind: "tool",
        payload: {
          ...event.payload,
          partialResult: boundLiveValue(event.payload.partialResult),
        },
      };
    } else {
      bounded = {
        kind: "tool",
        payload: { ...event.payload, result: boundLiveValue(event.payload.result) },
      };
    }
  } else if (event.kind === "lifecycle" && event.payload.phase === "error") {
    bounded = {
      kind: "lifecycle",
      payload: { ...event.payload, error: truncateLiveText(event.payload.error) },
    };
  } else {
    throw new Error(`worker live ${event.kind} event exceeds the protocol payload limit`);
  }
  if (liveEventBytes(bounded) > MAX_LIVE_EVENT_BYTES) {
    throw new Error(`worker live ${event.kind} event cannot fit the protocol payload limit`);
  }
  return bounded;
}

function coalescePendingLiveEvent(pending: WorkerLiveEvent[], event: WorkerLiveEvent): boolean {
  const index = pending.length - 1;
  const previous = pending[index];
  if (!previous) {
    return false;
  }
  if (previous.kind === "assistant" && event.kind === "assistant") {
    pending[index] = boundLiveEvent({
      kind: "assistant",
      payload: { ...event.payload, delta: event.payload.text, replace: true },
    });
    return true;
  }
  if (previous.kind === "thinking" && event.kind === "thinking") {
    if (event.payload.text === "" && event.payload.delta === "") {
      return false;
    }
    pending[index] = boundLiveEvent({
      kind: "thinking",
      payload: {
        text: event.payload.text,
        delta: `${previous.payload.delta}${event.payload.delta}`,
      },
    });
    return true;
  }
  if (
    previous.kind === "tool" &&
    previous.payload.phase === "update" &&
    event.kind === "tool" &&
    event.payload.phase === "update" &&
    previous.payload.toolCallId === event.payload.toolCallId
  ) {
    pending[index] = boundLiveEvent(event);
    return true;
  }
  return false;
}

export type WorkerEmbeddedInferenceRequest = {
  modelRef: WorkerInferenceModelRef;
  context: WorkerInferenceContext;
  options: WorkerInferenceOptions;
  signal?: AbortSignal;
};

export type WorkerEmbeddedInferenceClient = {
  stream: (
    request: WorkerEmbeddedInferenceRequest,
  ) => AssistantMessageEventStreamLike | Promise<AssistantMessageEventStreamLike>;
};

export type WorkerEmbeddedTranscriptClient = {
  commit: (messages: WorkerTranscriptMessage[]) => Promise<void>;
};

export type WorkerEmbeddedLiveClient = {
  emit: (event: WorkerLiveEvent) => Promise<void>;
};

export type RunWorkerEmbeddedTurnParams = {
  cwd: string;
  stateDir: string;
  sessionId: string;
  sessionKey: string;
  runId: string;
  prompt: string;
  modelRef: WorkerInferenceModelRef;
  inference: WorkerEmbeddedInferenceClient;
  transcript: WorkerEmbeddedTranscriptClient;
  live: WorkerEmbeddedLiveClient;
  initialMessages?: WorkerTranscriptMessage[];
  systemPrompt?: string;
  inferenceOptions?: WorkerInferenceOptions;
  signal?: AbortSignal;
};

export type RunWorkerEmbeddedTurnResult = {
  messages: WorkerTranscriptMessage[];
};

function cloneTextContent(part: { type: "text"; text: string; textSignature?: string }) {
  return {
    type: "text" as const,
    text: part.text,
    ...(part.textSignature ? { textSignature: part.textSignature } : {}),
  };
}

function cloneImageContent(part: { type: "image"; data: string; mimeType: string }) {
  return { type: "image" as const, data: part.data, mimeType: part.mimeType };
}

function cloneUsage(message: AssistantMessage): WorkerTranscriptMessage & { role: "assistant" } {
  return {
    role: "assistant",
    content: message.content.map((part) => {
      if (part.type === "text") {
        return cloneTextContent(part);
      }
      if (part.type === "thinking") {
        return {
          type: "thinking" as const,
          thinking: part.thinking,
          ...(part.thinkingSignature ? { thinkingSignature: part.thinkingSignature } : {}),
          ...(part.redacted === undefined ? {} : { redacted: part.redacted }),
        };
      }
      return {
        type: "toolCall" as const,
        id: part.id,
        name: part.name,
        arguments: structuredClone(part.arguments),
        ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
        ...(part.executionMode ? { executionMode: part.executionMode } : {}),
      };
    }),
    api: message.api,
    provider: message.provider,
    model: message.model,
    ...(message.responseModel ? { responseModel: message.responseModel } : {}),
    ...(message.responseId ? { responseId: message.responseId } : {}),
    ...(message.diagnostics
      ? {
          diagnostics: message.diagnostics.map((diagnostic) => ({
            type: diagnostic.type,
            timestamp: diagnostic.timestamp,
            ...(diagnostic.error
              ? {
                  error: {
                    ...(diagnostic.error.name ? { name: diagnostic.error.name } : {}),
                    message: diagnostic.error.message,
                    ...(diagnostic.error.stack ? { stack: diagnostic.error.stack } : {}),
                    ...(diagnostic.error.code === undefined ? {} : { code: diagnostic.error.code }),
                  },
                }
              : {}),
            ...(diagnostic.details ? { details: structuredClone(diagnostic.details) } : {}),
          })),
        }
      : {}),
    usage: {
      input: message.usage.input,
      output: message.usage.output,
      cacheRead: message.usage.cacheRead,
      cacheWrite: message.usage.cacheWrite,
      ...(message.usage.contextUsage
        ? { contextUsage: structuredClone(message.usage.contextUsage) }
        : {}),
      totalTokens: message.usage.totalTokens,
      cost: {
        input: message.usage.cost.input,
        output: message.usage.cost.output,
        cacheRead: message.usage.cost.cacheRead,
        cacheWrite: message.usage.cost.cacheWrite,
        total: message.usage.cost.total,
        ...(message.usage.cost.totalOrigin ? { totalOrigin: message.usage.cost.totalOrigin } : {}),
      },
    },
    stopReason: message.stopReason,
    ...(message.errorMessage ? { errorMessage: message.errorMessage } : {}),
    ...(message.errorCode ? { errorCode: message.errorCode } : {}),
    ...(message.errorType ? { errorType: message.errorType } : {}),
    ...(message.errorBody ? { errorBody: message.errorBody } : {}),
    timestamp: message.timestamp,
  };
}

function toWorkerTranscriptMessage(message: AgentMessage): WorkerTranscriptMessage | undefined {
  if (message.role === "user") {
    const content =
      typeof message.content === "string"
        ? [{ type: "text" as const, text: message.content }]
        : message.content.map((part) =>
            part.type === "text" ? cloneTextContent(part) : cloneImageContent(part),
          );
    return { role: "user", content, timestamp: message.timestamp };
  }
  if (message.role === "assistant") {
    return cloneUsage(message);
  }
  if (message.role === "toolResult") {
    return {
      role: "toolResult",
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      content: message.content.map((part) =>
        part.type === "text" ? cloneTextContent(part) : cloneImageContent(part),
      ),
      ...(message.details === undefined ? {} : { details: structuredClone(message.details) }),
      isError: message.isError,
      timestamp: message.timestamp,
    };
  }
  return undefined;
}

function toAgentMessage(message: WorkerTranscriptMessage): Message {
  if (message.role === "user") {
    return {
      role: "user",
      content: message.content.map((part) =>
        part.type === "text" ? cloneTextContent(part) : cloneImageContent(part),
      ),
      timestamp: message.timestamp,
    };
  }
  if (message.role === "toolResult") {
    return {
      role: "toolResult",
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      content: message.content.map((part) =>
        part.type === "text" ? cloneTextContent(part) : cloneImageContent(part),
      ),
      ...(message.details === undefined ? {} : { details: structuredClone(message.details) }),
      isError: message.isError,
      timestamp: message.timestamp,
    };
  }
  return {
    ...cloneUsage(message),
    diagnostics: message.diagnostics?.map((diagnostic) => structuredClone(diagnostic)),
  };
}

function toWorkerInferenceMessage(message: Message): WorkerInferenceContext["messages"][number] {
  if (message.role === "user") {
    return {
      role: "user",
      content:
        typeof message.content === "string"
          ? message.content
          : message.content.map((part) =>
              part.type === "text" ? cloneTextContent(part) : cloneImageContent(part),
            ),
      timestamp: message.timestamp,
      ...(message.runtimeContextCarrier ? { runtimeContextCarrier: true } : {}),
    };
  }
  const projected = toWorkerTranscriptMessage(message);
  if (!projected) {
    throw new Error(`Unsupported inference message role: ${message.role}`);
  }
  return projected;
}

function windowWorkerInferenceMessages(messages: Context["messages"]): Context["messages"] {
  if (messages.length <= WORKER_INFERENCE_MAX_CONTEXT_MESSAGES) {
    return messages;
  }
  const minimumStart = messages.length - WORKER_INFERENCE_MAX_CONTEXT_MESSAGES;
  // Start at a user turn when possible so truncation cannot orphan a tool result
  // from the assistant tool call that owns it.
  for (let index = minimumStart; index < messages.length; index += 1) {
    if (messages[index]?.role === "user") {
      return messages.slice(index);
    }
  }
  throw new Error("Worker inference context has no complete user turn within the message limit.");
}

function toWorkerInferenceContext(context: Context): WorkerInferenceContext {
  return {
    ...(context.systemPrompt === undefined ? {} : { systemPrompt: context.systemPrompt }),
    messages: windowWorkerInferenceMessages(context.messages).map(toWorkerInferenceMessage),
    ...(context.tools
      ? {
          tools: context.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: structuredClone(tool.parameters),
          })),
        }
      : {}),
  };
}

function readAssistantText(message: AgentMessage): string {
  if (message.role !== "assistant") {
    return "";
  }
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function readAssistantThinking(message: AgentMessage): string {
  if (message.role !== "assistant") {
    return "";
  }
  return message.content
    .filter((part) => part.type === "thinking")
    .map((part) => part.thinking)
    .join("");
}

export async function runWorkerEmbeddedTurn(
  params: RunWorkerEmbeddedTurnParams,
): Promise<RunWorkerEmbeddedTurnResult> {
  const model = createNativeModelOwnedRuntimeModel({
    provider: params.modelRef.provider,
    modelId: params.modelRef.model,
  });
  const authStorage = AuthStorage.inMemory({});
  const modelRegistry = ModelRegistry.inMemory(authStorage);
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  const bootstrapFiles = (await loadWorkspaceBootstrapFiles(params.cwd)).filter(
    (file) => file.name === DEFAULT_AGENTS_FILENAME,
  );
  const contextFiles = buildBootstrapContextForFiles(bootstrapFiles, {});
  const resourceLoader = new DefaultResourceLoader({
    cwd: params.cwd,
    agentDir: params.stateDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    ...(params.systemPrompt === undefined ? {} : { systemPrompt: params.systemPrompt }),
    agentsFilesOverride: () => ({ agentsFiles: contextFiles }),
  });
  await resourceLoader.reload();

  const baseSessionManager = SessionManager.inMemory(params.cwd);
  for (const message of params.initialMessages ?? []) {
    baseSessionManager.appendMessage(toAgentMessage(message));
  }

  const pendingTranscriptMessages: WorkerTranscriptMessage[] = [];
  const sessionManager = guardSessionManager(baseSessionManager, {
    onMessagePersisted: (message) => {
      const projected = toWorkerTranscriptMessage(message);
      if (projected) {
        if (!isWorkerTranscriptMessageFrameSafe(projected)) {
          throw new Error("Worker transcript message exceeds the protocol payload limit.");
        }
        pendingTranscriptMessages.push(projected);
      }
    },
  });
  const flushTranscript = async () => {
    while (pendingTranscriptMessages.length > 0) {
      const batch = pendingTranscriptMessages.slice(0, WORKER_TRANSCRIPT_MAX_BATCH_MESSAGES);
      await params.transcript.commit(batch);
      pendingTranscriptMessages.splice(0, batch.length);
    }
  };
  let sessionWriteQueue: Promise<unknown> = Promise.resolve();
  const withSessionWriteLock = <T>(operation: () => Promise<T> | T): Promise<T> => {
    const result = sessionWriteQueue.then(async () => {
      const value = await operation();
      await flushTranscript();
      return value;
    });
    sessionWriteQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const toolNameSet = new Set<string>(LOCAL_WORKER_TOOL_NAMES);
  const localTools = createOpenClawCodingTools({
    cwd: params.cwd,
    workspaceDir: params.cwd,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    runSessionKey: params.sessionKey,
    runId: params.runId,
    oneShotCliRun: true,
    senderIsOwner: true,
    disableMessageTool: true,
    runtimeToolAllowlist: [...LOCAL_WORKER_TOOL_NAMES],
    modelProvider: params.modelRef.provider,
    modelId: params.modelRef.model,
    modelApi: model.api,
    modelContextWindowTokens: model.contextWindow,
    config: { plugins: { enabled: false } },
    exec: { host: "gateway", security: "full", ask: "off" },
    toolConstructionPlan: {
      includeBaseCodingTools: true,
      includeShellTools: true,
      includeChannelTools: false,
      includeOpenClawTools: false,
      includePluginTools: false,
    },
  }).filter((tool) => toolNameSet.has(tool.name));
  const discoveredToolNames = new Set(localTools.map((tool) => tool.name));
  for (const toolName of LOCAL_WORKER_TOOL_NAMES) {
    if (!discoveredToolNames.has(toolName)) {
      throw new Error(`Worker coding tool unavailable: ${toolName}`);
    }
  }

  const { session } = await createAgentSession({
    cwd: params.cwd,
    agentDir: params.stateDir,
    authStorage,
    modelRegistry,
    model,
    thinkingLevel: "medium",
    tools: [...LOCAL_WORKER_TOOL_NAMES],
    customTools: toToolDefinitions(localTools),
    noTools: "all",
    sessionManager,
    settingsManager,
    resourceLoader,
    withSessionWriteLock,
  });
  session.agent.sessionId = params.sessionId;
  session.setActiveToolsByName([...LOCAL_WORKER_TOOL_NAMES]);
  session.agent.streamFn = (_model, context, options) =>
    params.inference.stream({
      modelRef: params.modelRef,
      context: toWorkerInferenceContext(context),
      options: structuredClone(params.inferenceOptions ?? {}),
      ...(options?.signal ? { signal: options.signal } : {}),
    });

  const pendingLiveEvents: WorkerLiveEvent[] = [];
  let liveDrain: Promise<void> | undefined;
  let liveDegraded = false;
  const startLiveDrain = () => {
    if (liveDrain || liveDegraded || pendingLiveEvents.length === 0) {
      return;
    }
    liveDrain = (async () => {
      while (true) {
        const event = pendingLiveEvents.shift();
        if (!event) {
          return;
        }
        await params.live.emit(event);
      }
    })()
      .catch(() => {
        // Live events are preview-only; transcript commits and inference stay authoritative.
        liveDegraded = true;
        pendingLiveEvents.length = 0;
      })
      .finally(() => {
        liveDrain = undefined;
        startLiveDrain();
      });
  };
  const enqueueLive = (event: WorkerLiveEvent) => {
    if (liveDegraded) {
      return;
    }
    try {
      const bounded = boundLiveEvent(event);
      if (!coalescePendingLiveEvent(pendingLiveEvents, bounded)) {
        pendingLiveEvents.push(bounded);
      }
      startLiveDrain();
    } catch {
      liveDegraded = true;
      pendingLiveEvents.length = 0;
    }
  };
  const flushLive = async () => {
    let drain = liveDrain;
    while (drain) {
      await drain;
      drain = liveDrain;
    }
  };
  const startedAt = Date.now();
  let lifecycleFinished = false;
  let streamedText = "";
  let streamedThinking = "";
  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "agent_start") {
      enqueueLive({ kind: "lifecycle", payload: { phase: "start", startedAt } });
      return;
    }
    if (event.type === "message_start" && event.message.role === "assistant") {
      streamedText = "";
      streamedThinking = "";
      return;
    }
    if (event.type === "message_update") {
      if (event.assistantMessageEvent.type === "text_delta") {
        streamedText = readAssistantText(event.message);
        enqueueLive({
          kind: "assistant",
          payload: { text: streamedText, delta: event.assistantMessageEvent.delta },
        });
      } else if (event.assistantMessageEvent.type === "thinking_delta") {
        streamedThinking = readAssistantThinking(event.message);
        enqueueLive({
          kind: "thinking",
          payload: { text: streamedThinking, delta: event.assistantMessageEvent.delta },
        });
      }
      return;
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      const finalText = readAssistantText(event.message);
      if (finalText !== streamedText) {
        enqueueLive({
          kind: "assistant",
          payload: { text: finalText, delta: finalText, replace: true },
        });
      }
      const finalThinking = readAssistantThinking(event.message);
      if (finalThinking !== streamedThinking) {
        enqueueLive({
          kind: "thinking",
          payload: { text: finalThinking, delta: finalThinking },
        });
      }
      return;
    }
    if (event.type === "tool_execution_start") {
      enqueueLive({
        kind: "tool",
        payload: {
          phase: "start",
          name: event.toolName,
          toolCallId: event.toolCallId,
          args: event.args,
          ...(event.hideFromChannelProgress ? { hideFromChannelProgress: true } : {}),
        },
      });
      return;
    }
    if (event.type === "tool_execution_update") {
      enqueueLive({
        kind: "tool",
        payload: {
          phase: "update",
          name: event.toolName,
          toolCallId: event.toolCallId,
          partialResult: event.partialResult,
          ...(event.hideFromChannelProgress ? { hideFromChannelProgress: true } : {}),
        },
      });
      return;
    }
    if (event.type === "tool_execution_end") {
      enqueueLive({
        kind: "tool",
        payload: {
          phase: "result",
          name: event.toolName,
          toolCallId: event.toolCallId,
          isError: event.isError,
          result: event.result,
          ...(event.hideFromChannelProgress ? { hideFromChannelProgress: true } : {}),
        },
      });
      return;
    }
    if (event.type === "agent_end") {
      lifecycleFinished = true;
      const lastAssistant = event.messages
        .toReversed()
        .find((message): message is AssistantMessage => message.role === "assistant");
      if (lastAssistant?.stopReason === "error") {
        enqueueLive({
          kind: "lifecycle",
          payload: {
            phase: "error",
            startedAt,
            endedAt: Date.now(),
            error: lastAssistant.errorMessage ?? "Worker inference failed.",
          },
        });
      } else if (lastAssistant?.stopReason === "aborted") {
        enqueueLive({
          kind: "lifecycle",
          payload: {
            phase: "end",
            startedAt,
            endedAt: Date.now(),
            stopReason: "aborted",
            aborted: true,
          },
        });
      } else {
        enqueueLive({
          kind: "lifecycle",
          payload: { phase: "end", startedAt, endedAt: Date.now() },
        });
      }
    }
  });

  const abortTurn = () => session.agent.abort();
  params.signal?.addEventListener("abort", abortTurn, { once: true });

  let runFailure: Error | undefined;
  try {
    if (params.signal?.aborted) {
      throw toError(params.signal.reason, "Worker agent turn aborted.");
    }
    await session.agent.prompt({
      role: "user",
      content: [{ type: "text", text: params.prompt }],
      timestamp: Date.now(),
    });
    await session.agent.waitForIdle();
    if (params.signal?.aborted) {
      throw toError(params.signal.reason, "Worker agent turn aborted.");
    }
    const terminalAssistant = session.agent.state.messages
      .toReversed()
      .find((message): message is AssistantMessage => message.role === "assistant");
    if (terminalAssistant?.stopReason === "error") {
      throw new Error(terminalAssistant.errorMessage ?? "Worker inference failed.");
    }
    if (terminalAssistant?.stopReason === "aborted") {
      throw new Error(terminalAssistant.errorMessage ?? "Worker inference was aborted.");
    }
  } catch (error) {
    runFailure = params.signal?.aborted
      ? toError(params.signal.reason, "Worker agent turn aborted.")
      : toError(error, "Worker agent turn failed.");
    if (!lifecycleFinished) {
      if (params.signal?.aborted) {
        enqueueLive({
          kind: "lifecycle",
          payload: {
            phase: "end",
            startedAt,
            endedAt: Date.now(),
            stopReason: "aborted",
            aborted: true,
          },
        });
      } else {
        enqueueLive({
          kind: "lifecycle",
          payload: {
            phase: "error",
            startedAt,
            endedAt: Date.now(),
            error: runFailure.message,
          },
        });
      }
    }
  }

  let finalTranscriptFailure: Error | undefined;
  try {
    if (!params.signal?.aborted) {
      try {
        await withSessionWriteLock(() => undefined);
      } catch (error) {
        finalTranscriptFailure = toError(error, "Worker transcript flush failed.");
      }
      await flushLive();
    }
  } finally {
    params.signal?.removeEventListener("abort", abortTurn);
    unsubscribe();
    getProcessSupervisor().cancelScope(params.sessionKey, "manual-cancel");
    session.dispose();
  }
  if (runFailure !== undefined) {
    throw runFailure;
  }
  if (finalTranscriptFailure !== undefined) {
    throw finalTranscriptFailure;
  }

  return {
    messages: session.agent.state.messages.flatMap((message) => {
      const projected = toWorkerTranscriptMessage(message);
      return projected ? [projected] : [];
    }),
  };
}
