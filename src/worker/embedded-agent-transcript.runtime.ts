import type { WorkerTranscriptMessage } from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import { WORKER_TRANSCRIPT_MAX_BATCH_MESSAGES } from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import type { WorkerInferenceContext } from "../../packages/gateway-protocol/src/schema/worker-inference.js";
import { WORKER_INFERENCE_MAX_CONTEXT_MESSAGES } from "../../packages/gateway-protocol/src/schema/worker-inference.js";
import type { AgentMessage } from "../agents/runtime/index.js";
import type { AgentSessionWriteLockRunner } from "../agents/sessions/agent-session.js";
import type { AssistantMessage, Context, Message } from "../llm/types.js";
import { isWorkerTranscriptMessageFrameSafe } from "./transcript-message.js";

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

export function toWorkerTranscriptMessage(
  message: AgentMessage,
): WorkerTranscriptMessage | undefined {
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

export function toAgentMessage(message: WorkerTranscriptMessage): Message {
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

export function toWorkerInferenceContext(context: Context): WorkerInferenceContext {
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

type WorkerTranscriptClient = {
  commit: (messages: WorkerTranscriptMessage[]) => Promise<void>;
};

type WorkerTranscriptRuntime = {
  onMessagePersisted: (message: AgentMessage) => void;
  withSessionWriteLock: AgentSessionWriteLockRunner;
};

export function createWorkerTranscriptRuntime(
  client: WorkerTranscriptClient,
): WorkerTranscriptRuntime {
  const pendingTranscriptMessages: WorkerTranscriptMessage[] = [];
  const onMessagePersisted = (message: AgentMessage) => {
    const projected = toWorkerTranscriptMessage(message);
    if (projected) {
      if (!isWorkerTranscriptMessageFrameSafe(projected)) {
        throw new Error("Worker transcript message exceeds the protocol payload limit.");
      }
      pendingTranscriptMessages.push(projected);
    }
  };
  const flushTranscript = async () => {
    while (pendingTranscriptMessages.length > 0) {
      const batch = pendingTranscriptMessages.slice(0, WORKER_TRANSCRIPT_MAX_BATCH_MESSAGES);
      await client.commit(batch);
      pendingTranscriptMessages.splice(0, batch.length);
    }
  };
  let sessionWriteQueue: Promise<unknown> = Promise.resolve();
  const withSessionWriteLock: AgentSessionWriteLockRunner = <T>(
    operation: () => Promise<T> | T,
  ): Promise<T> => {
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
  return { onMessagePersisted, withSessionWriteLock };
}
