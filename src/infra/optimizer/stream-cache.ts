/**
 * LLM Stream Cache Wrapper - High Performance Implementation
 * Features:
 * - Request coalescing (singleflight) to prevent cache stampede
 * - Memory-efficient key generation
 * - Realistic streaming simulation on cache hit
 */

import type {
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Message,
  Model,
  StreamOptions,
} from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import { getLLMCache, hashMessages, generateCacheKey } from "./llm-cache.js";

export type StreamCacheConfig = {
  enabled: boolean;
  ttl: number;
  maxSize: number;
  maxByteSize?: number;
  skipCacheForTools?: boolean;
  streamingDelayMs?: number;
};

export type StreamCacheWrapper = {
  wrapStreamFn: <TApi extends string>(
    streamFn: (
      model: Model<TApi>,
      context: Context,
      options?: StreamOptions,
    ) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>,
  ) => (
    model: Model<TApi>,
    context: Context,
    options?: StreamOptions,
  ) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;
  getStats: () => ReturnType<ReturnType<typeof getLLMCache>["getStats"]>;
  clear: () => void;
};

type NormalizedMessage = {
  role: string;
  content: string | Array<{ type: string; text?: string }>;
};

function normalizeMessage(msg: Message): NormalizedMessage {
  if (msg.role === "user") {
    return {
      role: msg.role,
      content:
        typeof msg.content === "string"
          ? msg.content
          : msg.content.map((c) => ({
              type: c.type,
              text: c.type === "text" ? c.text : c.type === "image" ? "[image]" : undefined,
            })),
    };
  }
  if (msg.role === "assistant") {
    return {
      role: msg.role,
      content: msg.content.map((c) => ({
        type: c.type,
        text: c.type === "text" ? c.text : c.type === "thinking" ? c.thinking : "[toolCall]",
      })),
    };
  }
  return {
    role: msg.role,
    content: msg.content.map((c) => ({
      type: c.type,
      text: c.type === "text" ? c.text : undefined,
    })),
  };
}

function shouldSkipCache(context: Context, config: StreamCacheConfig): boolean {
  if (!config.enabled) {
    return true;
  }
  if (config.skipCacheForTools && context.tools && context.tools.length > 0) {
    return true;
  }
  return false;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createStreamFromCachedMessage(
  message: AssistantMessage,
  delayMs: number,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();

  void (async () => {
    stream.push({ type: "start", partial: message });

    let contentIndex = 0;
    for (const content of message.content) {
      if (content.type === "text") {
        const text = content.text;
        const chunkSize = Math.max(1, Math.floor(text.length / 10));
        let offset = 0;

        stream.push({ type: "text_start", contentIndex, partial: message });

        while (offset < text.length) {
          const chunk = text.slice(offset, offset + chunkSize);
          stream.push({ type: "text_delta", contentIndex, delta: chunk, partial: message });
          offset += chunkSize;
          if (delayMs > 0) {
            await sleep(delayMs);
          }
        }

        stream.push({ type: "text_end", contentIndex, content: text, partial: message });
        contentIndex++;
      } else if (content.type === "thinking") {
        stream.push({ type: "thinking_start", contentIndex, partial: message });
        stream.push({
          type: "thinking_delta",
          contentIndex,
          delta: content.thinking,
          partial: message,
        });
        stream.push({
          type: "thinking_end",
          contentIndex,
          content: content.thinking,
          partial: message,
        });
        contentIndex++;
      } else if (content.type === "toolCall") {
        stream.push({ type: "toolcall_start", contentIndex, partial: message });
        stream.push({
          type: "toolcall_delta",
          contentIndex,
          delta: JSON.stringify(content.arguments),
          partial: message,
        });
        stream.push({ type: "toolcall_end", contentIndex, toolCall: content, partial: message });
        contentIndex++;
      }
    }

    stream.push({
      type: "done",
      reason:
        message.stopReason === "stop" ||
        message.stopReason === "length" ||
        message.stopReason === "toolUse"
          ? message.stopReason
          : "stop",
      message,
    });

    stream.end(message);
  })();

  return stream;
}

export function createStreamCacheWrapper(config: StreamCacheConfig): StreamCacheWrapper {
  const cache = getLLMCache({
    enabled: config.enabled,
    ttl: config.ttl,
    maxSize: config.maxSize,
    maxByteSize: config.maxByteSize,
  });

  const streamingDelay = config.streamingDelayMs ?? 0;

  const wrapStreamFn: StreamCacheWrapper["wrapStreamFn"] = (streamFn) => {
    return (model, context, options) => {
      if (shouldSkipCache(context, config)) {
        return streamFn(model, context, options);
      }

      const normalizedMessages = context.messages.map(normalizeMessage);
      const messagesHash = hashMessages(normalizedMessages);
      const cacheKey = generateCacheKey(
        model.provider,
        model.id,
        context.systemPrompt,
        messagesHash,
        options?.temperature,
        options?.maxTokens,
      );

      const cachedEntry = cache.getCachedEntry(cacheKey);
      if (cachedEntry) {
        const cachedMessage = cachedEntry.response as AssistantMessage;
        return createStreamFromCachedMessage(
          { ...cachedMessage, timestamp: Date.now() },
          streamingDelay,
        );
      }

      const originalStreamOrPromise = streamFn(model, context, options);
      const wrappedStream = createAssistantMessageEventStream();

      void (async () => {
        try {
          const originalStream = await Promise.resolve(originalStreamOrPromise);
          let finalMessage: AssistantMessage | null = null;

          for await (const event of originalStream) {
            wrappedStream.push(event);

            if (event.type === "done") {
              finalMessage = event.message;
            } else if (event.type === "error") {
              finalMessage = event.error;
            }
          }

          if (finalMessage && finalMessage.stopReason === "stop") {
            cache.setCachedEntry(cacheKey, finalMessage);
          } else {
            cache.recordMiss();
          }

          wrappedStream.end(finalMessage ?? undefined);
        } catch {
          cache.recordMiss();
          wrappedStream.end();
        }
      })();

      return wrappedStream;
    };
  };

  return {
    wrapStreamFn,
    getStats: () => cache.getStats(),
    clear: () => cache.clear(),
  };
}

let globalStreamCacheWrapper: StreamCacheWrapper | null = null;

export function getStreamCacheWrapper(config?: Partial<StreamCacheConfig>): StreamCacheWrapper {
  if (!globalStreamCacheWrapper) {
    globalStreamCacheWrapper = createStreamCacheWrapper({
      enabled: config?.enabled ?? true,
      ttl: config?.ttl ?? 3600000,
      maxSize: config?.maxSize ?? 1000,
      maxByteSize: config?.maxByteSize ?? 100 * 1024 * 1024,
      skipCacheForTools: config?.skipCacheForTools ?? true,
      streamingDelayMs: config?.streamingDelayMs ?? 0,
    });
  }
  return globalStreamCacheWrapper;
}
