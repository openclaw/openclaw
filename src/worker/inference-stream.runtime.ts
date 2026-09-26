import {
  createToolArgumentPreviewSchedule,
  parseStreamingJson,
  parseTerminalToolCallArguments,
  type ToolArgumentPreviewSchedule,
} from "@openclaw/ai/internal/runtime";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { WORKER_PROTOCOL_MAX_IDENTIFIER_LENGTH } from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import type {
  WorkerInferenceContext,
  WorkerInferenceEventParams,
  WorkerInferenceModelRef,
  WorkerInferenceOptions,
  WorkerInferenceStartParams,
} from "../../packages/gateway-protocol/src/schema/worker-inference.js";
import {
  invalidateComputerFrameIfMissing,
  type ComputerContextEpoch,
} from "../agents/tools/computer-tool.js";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStreamLike,
  ToolCall,
} from "../llm/types.js";
import { createAssistantMessageEventStream } from "../llm/utils/event-stream.js";
import { fitWorkerReplayImages } from "./replay-message-window.js";
import {
  isWorkerTranscriptMessageFrameSafe,
  WORKER_PROVIDER_REPLAY_LOCAL_RETRY_MESSAGE,
} from "./transcript-message.js";
import type { WorkerInferenceProxyClient } from "./worker-rpc-inference-client.js";

type StreamingToolCall = ToolCall & {
  partialJson: string;
};

type WorkerInferenceStreamAdapterOptions = {
  client: WorkerInferenceProxyClient;
  sessionId: string;
  runEpoch: number;
  runId: string;
  turnId: string;
  modelRef: WorkerInferenceModelRef;
  computerContextEpoch?: ComputerContextEpoch;
};

type WorkerInferenceStreamRequest = {
  modelRef: WorkerInferenceModelRef;
  context: WorkerInferenceContext;
  options: WorkerInferenceOptions;
  signal?: AbortSignal;
};

function emptyAssistantMessage(modelRef: WorkerInferenceModelRef): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "openai-responses",
    provider: modelRef.provider,
    model: modelRef.model,
    stopReason: "stop",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    timestamp: Date.now(),
  };
}

function processInferenceEvent(
  payload: WorkerInferenceEventParams,
  partial: AssistantMessage,
  toolArgumentPreviewSchedules: Map<number, ToolArgumentPreviewSchedule>,
  tolerateMissingState: boolean,
): AssistantMessageEvent | undefined {
  const event = payload.event;
  switch (event.type) {
    case "start": {
      partial.api = event.resolvedModel.api as AssistantMessage["api"];
      partial.provider = event.resolvedModel.provider;
      partial.model = event.resolvedModel.model;
      partial.timestamp = event.timestamp;
      return { type: "start", partial };
    }
    case "text_start": {
      partial.content[event.contentIndex] = {
        type: "text",
        text: "",
        ...(event.contentSignature === undefined ? {} : { textSignature: event.contentSignature }),
      };
      return { type: "text_start", contentIndex: event.contentIndex, partial };
    }
    case "text_delta":
    case "text_end": {
      const content = partial.content[event.contentIndex];
      if (content?.type !== "text") {
        if (tolerateMissingState) {
          return undefined;
        }
        throw new Error(
          `worker inference text ${event.type === "text_delta" ? "delta" : "end"} has no active text block`,
        );
      }
      if (event.type === "text_delta") {
        content.text += event.delta;
        return {
          type: "text_delta",
          contentIndex: event.contentIndex,
          delta: event.delta,
          partial,
        };
      }
      if (event.contentSignature !== undefined) {
        content.textSignature = event.contentSignature;
      }
      return {
        type: "text_end",
        contentIndex: event.contentIndex,
        content: content.text,
        partial,
      };
    }
    case "thinking_start": {
      partial.content[event.contentIndex] = { type: "thinking", thinking: "" };
      return { type: "thinking_start", contentIndex: event.contentIndex, partial };
    }
    case "thinking_delta":
    case "thinking_end": {
      const content = partial.content[event.contentIndex];
      if (content?.type !== "thinking") {
        if (tolerateMissingState) {
          return undefined;
        }
        throw new Error(
          `worker inference thinking ${event.type === "thinking_delta" ? "delta" : "end"} has no active thinking block`,
        );
      }
      if (event.type === "thinking_delta") {
        content.thinking += event.delta;
        return {
          type: "thinking_delta",
          contentIndex: event.contentIndex,
          delta: event.delta,
          partial,
        };
      }
      if (event.contentSignature !== undefined) {
        content.thinkingSignature = event.contentSignature;
      }
      return {
        type: "thinking_end",
        contentIndex: event.contentIndex,
        content: content.thinking,
        partial,
      };
    }
    case "toolcall_start": {
      const content = {
        type: "toolCall",
        id: event.id,
        name: event.toolName,
        arguments: {},
        partialJson: "",
      } satisfies StreamingToolCall;
      partial.content[event.contentIndex] = content;
      toolArgumentPreviewSchedules.set(event.contentIndex, createToolArgumentPreviewSchedule());
      return { type: "toolcall_start", contentIndex: event.contentIndex, partial };
    }
    case "toolcall_delta":
    case "toolcall_end": {
      const content = partial.content[event.contentIndex];
      if (content?.type !== "toolCall") {
        if (tolerateMissingState) {
          return undefined;
        }
        throw new Error(
          `worker inference tool ${event.type === "toolcall_delta" ? "delta" : "end"} has no active tool call`,
        );
      }
      const streaming = content as StreamingToolCall;
      if (event.type === "toolcall_delta") {
        streaming.partialJson += event.delta;
        const previewSchedule = toolArgumentPreviewSchedules.get(event.contentIndex);
        if (!previewSchedule) {
          throw new Error("worker inference tool delta has no preview schedule");
        }
        if (previewSchedule(streaming.partialJson.length)) {
          content.arguments = parseStreamingJson(streaming.partialJson);
        }
        return {
          type: "toolcall_delta",
          contentIndex: event.contentIndex,
          delta: event.delta,
          partial,
        };
      }
      content.arguments = parseTerminalToolCallArguments(streaming.partialJson);
      toolArgumentPreviewSchedules.delete(event.contentIndex);
      delete (content as Partial<StreamingToolCall>).partialJson;
      return { type: "toolcall_end", contentIndex: event.contentIndex, toolCall: content, partial };
    }
  }
  return undefined;
}

function transcriptSafeErrorMessage(
  modelRef: WorkerInferenceModelRef,
  message: AssistantMessage,
): AssistantMessage {
  if (isWorkerTranscriptMessageFrameSafe(message)) {
    return message;
  }
  const replacement = emptyAssistantMessage(modelRef);
  replacement.api = message.api;
  replacement.provider = message.provider;
  replacement.model = message.model;
  replacement.timestamp = message.timestamp;
  replacement.stopReason = message.stopReason === "aborted" ? "aborted" : "error";
  replacement.errorMessage = truncateUtf16Safe(
    message.errorMessage ?? "Worker inference result exceeds the transcript message limit.",
    256,
  );
  replacement.usage = structuredClone(message.usage);
  return replacement;
}

function createInferenceRequestMeasure(request: WorkerInferenceStartParams) {
  const measureFull = (messages: WorkerInferenceContext["messages"]) =>
    Buffer.byteLength(
      JSON.stringify({
        type: "req",
        // The dispatcher creates UUID request IDs: this has the exact same encoded size.
        id: "00000000-0000-4000-8000-000000000000",
        method: "worker.inference.start",
        params: { ...request, context: { ...request.context, messages } },
      }),
      "utf8",
    );
  let envelopeBytes = 0;
  let messageBytes: WeakMap<WorkerInferenceContext["messages"][number], number> | undefined;
  return (messages: WorkerInferenceContext["messages"]) => {
    // Fitting requests keep the single full encoding; allocate only after pruning starts.
    if (messages === request.context.messages) {
      return measureFull(messages);
    }
    if (!messageBytes) {
      envelopeBytes = measureFull([]);
      messageBytes = new WeakMap();
    }
    let bytes = envelopeBytes + Math.max(0, messages.length - 1);
    for (const message of messages) {
      // The fitter replaces each changed message but reuses its candidate array.
      // Cache message sizes only, scoped to this cloned request's synchronous fitting.
      let size = messageBytes.get(message);
      if (size === undefined) {
        size = Buffer.byteLength(JSON.stringify(message), "utf8");
        messageBytes.set(message, size);
      }
      bytes += size;
    }
    return bytes;
  };
}

export function createWorkerInferenceStreamAdapter(
  adapter: WorkerInferenceStreamAdapterOptions,
): (request: WorkerInferenceStreamRequest) => AssistantMessageEventStreamLike {
  let modelCallSeq = 0;
  return (inferenceRequest) => {
    const stream = createAssistantMessageEventStream();
    const partial = emptyAssistantMessage(adapter.modelRef);
    const toolArgumentPreviewSchedules = new Map<number, ToolArgumentPreviewSchedule>();
    let streamHasGap = false;
    let settled = false;
    modelCallSeq += 1;
    const turnSuffix = `:${modelCallSeq}`;
    const identity = {
      runEpoch: adapter.runEpoch,
      sessionId: adapter.sessionId,
      runId: adapter.runId,
      turnId: `${adapter.turnId.slice(
        0,
        WORKER_PROTOCOL_MAX_IDENTIFIER_LENGTH - turnSuffix.length,
      )}${turnSuffix}`,
    };
    let request: WorkerInferenceStartParams = {
      ...identity,
      modelRef: inferenceRequest.modelRef,
      context: structuredClone(inferenceRequest.context),
      options: structuredClone(inferenceRequest.options),
    };
    const finishError = (
      error: unknown,
      reason: "aborted" | "error",
      usage?: AssistantMessage["usage"],
    ) => {
      if (settled) {
        return;
      }
      settled = true;
      partial.stopReason = reason;
      partial.errorMessage = error instanceof Error ? error.message : String(error);
      if (usage) {
        partial.usage = structuredClone(usage);
      }
      stream.push({
        type: "error",
        reason,
        error: transcriptSafeErrorMessage(adapter.modelRef, partial),
      });
      stream.end();
    };
    const fail = (error: unknown) =>
      finishError(error, inferenceRequest.signal?.aborted ? "aborted" : "error");
    const abort = () => {
      void adapter.client
        .cancel(identity)
        .catch(() => undefined)
        .finally(() => finishError("Worker inference aborted.", "aborted"));
    };
    if (inferenceRequest.signal?.aborted) {
      finishError("Worker inference aborted before start.", "aborted");
      return stream;
    }
    try {
      const messages = fitWorkerReplayImages(
        request.context.messages,
        createInferenceRequestMeasure(request),
        adapter.computerContextEpoch?.frameToolCallId,
      );
      if (!messages) {
        throw new Error(
          request.context.messages.some(
            (message) => message.role === "assistant" && message.providerReplay !== undefined,
          )
            ? `${WORKER_PROVIDER_REPLAY_LOCAL_RETRY_MESSAGE} (inference payload limit)`
            : "Worker inference context exceeds the image transport limit. Use fewer or smaller images in this turn, then retry.",
        );
      }
      request = { ...request, context: { ...request.context, messages } };
      if (adapter.computerContextEpoch) {
        invalidateComputerFrameIfMissing({
          contextEpoch: adapter.computerContextEpoch,
          messages: messages.filter((message) => message.role === "toolResult"),
        });
      }
    } catch (error) {
      fail(error);
      return stream;
    }
    inferenceRequest.signal?.addEventListener("abort", abort, { once: true });
    void adapter.client
      .start(request, {
        onStreamGap: () => {
          streamHasGap = true;
        },
        onEvent: (event) => {
          const projected = processInferenceEvent(
            event,
            partial,
            toolArgumentPreviewSchedules,
            streamHasGap,
          );
          if (projected) {
            stream.push(projected);
          }
        },
      })
      .then((outcome) => {
        if (settled) {
          return;
        }
        if (outcome.type === "done") {
          settled = true;
          if (!isWorkerTranscriptMessageFrameSafe(outcome.message)) {
            const message = emptyAssistantMessage(adapter.modelRef);
            message.stopReason = "error";
            message.errorMessage = "Worker inference result exceeds the transcript message limit.";
            message.usage = structuredClone(outcome.message.usage);
            stream.push({ type: "error", reason: "error", error: message });
            stream.end();
            return;
          }
          const reason = outcome.message.stopReason;
          const message = structuredClone(outcome.message) as AssistantMessage;
          stream.push({ type: "done", reason, message });
          stream.end();
          return;
        }
        finishError(
          outcome.message,
          outcome.reason === "cancelled" ? "aborted" : "error",
          outcome.usage,
        );
      })
      .catch(fail)
      .finally(() => {
        inferenceRequest.signal?.removeEventListener("abort", abort);
      });
    return stream;
  };
}
