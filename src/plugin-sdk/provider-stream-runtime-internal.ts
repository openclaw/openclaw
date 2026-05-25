import { randomUUID } from "node:crypto";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, streamSimple } from "@earendil-works/pi-ai";
import { parseStandalonePlainTextToolCallBlocks } from "./tool-payload.js";

function toRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function resolveContextToolNames(context: Parameters<StreamFn>[1]): Set<string> {
  const tools = (context as { tools?: unknown }).tools;
  if (!Array.isArray(tools)) {
    return new Set();
  }
  const names = tools
    .map((tool) => {
      const record = toRecord(tool);
      return typeof record?.name === "string" && record.name.trim() ? record.name : undefined;
    })
    .filter((name): name is string => Boolean(name));
  return new Set(names);
}

function couldStillBePlainTextToolCall(text: string): boolean {
  if (text.length > 256_000) {
    return false;
  }
  const trimmed = text.trimStart();
  return (
    trimmed.length === 0 ||
    trimmed.startsWith("[") ||
    trimmed.startsWith("<|channel|>") ||
    trimmed.startsWith("commentary") ||
    trimmed.startsWith("analysis") ||
    trimmed.startsWith("final")
  );
}

function createSyntheticToolCallId(): string {
  return `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

function createPlainTextToolCallBlock(parsed: {
  arguments: Record<string, unknown>;
  name: string;
}): Record<string, unknown> {
  return {
    type: "toolCall",
    id: createSyntheticToolCallId(),
    name: parsed.name,
    arguments: parsed.arguments,
    partialArgs: JSON.stringify(parsed.arguments),
  };
}

function promotePlainTextToolCalls(
  message: unknown,
  toolNames: Set<string>,
): Record<string, unknown> | undefined {
  const messageRecord = toRecord(message);
  if (!messageRecord) {
    return undefined;
  }
  if (!Array.isArray(messageRecord.content)) {
    if (typeof messageRecord.content !== "string" || !messageRecord.content.trim()) {
      return undefined;
    }
    const parsed = parseStandalonePlainTextToolCallBlocks(messageRecord.content, {
      allowedToolNames: toolNames,
    });
    if (!parsed) {
      return undefined;
    }
    return {
      ...messageRecord,
      content: parsed.map(createPlainTextToolCallBlock),
      stopReason: "toolUse",
    };
  }
  if (
    messageRecord.content.some((block) => toRecord(block)?.type === "toolCall") ||
    messageRecord.content.length === 0
  ) {
    return undefined;
  }

  let promoted = false;
  const nextContent: Array<Record<string, unknown>> = [];
  for (const block of messageRecord.content) {
    const blockRecord = toRecord(block);
    if (!blockRecord) {
      return undefined;
    }
    if (blockRecord.type !== "text") {
      nextContent.push(blockRecord);
      continue;
    }
    const text = typeof blockRecord.text === "string" ? blockRecord.text : "";
    if (!text.trim()) {
      continue;
    }
    const parsed = parseStandalonePlainTextToolCallBlocks(text, {
      allowedToolNames: toolNames,
    });
    if (!parsed) {
      return undefined;
    }
    nextContent.push(...parsed.map(createPlainTextToolCallBlock));
    promoted = true;
  }

  if (!promoted) {
    return undefined;
  }
  return {
    ...messageRecord,
    content: nextContent,
    stopReason: "toolUse",
  };
}

function emitPromotedToolCallEvents(
  stream: { push(event: unknown): void },
  message: Record<string, unknown>,
): void {
  const content = Array.isArray(message.content) ? message.content : [];
  content.forEach((block, contentIndex) => {
    const record = toRecord(block);
    if (record?.type !== "toolCall") {
      return;
    }
    stream.push({ type: "toolcall_start", contentIndex, partial: message });
    stream.push({
      type: "toolcall_delta",
      contentIndex,
      delta: typeof record.partialArgs === "string" ? record.partialArgs : "{}",
      partial: message,
    });
  });
}

function wrapPlainTextToolCallStream(
  source: ReturnType<StreamFn>,
  context: Parameters<StreamFn>[1],
): ReturnType<StreamFn> {
  const toolNames = resolveContextToolNames(context);
  if (toolNames.size === 0) {
    return source;
  }
  const output = createAssistantMessageEventStream();
  const stream = output as unknown as { push(event: unknown): void; end(): void };

  void (async () => {
    const bufferedTextEvents: unknown[] = [];
    let bufferedText = "";
    let ended = false;
    const endStream = () => {
      if (!ended) {
        ended = true;
        stream.end();
      }
    };
    const flushBufferedTextEvents = () => {
      for (const event of bufferedTextEvents.splice(0)) {
        stream.push(event);
      }
      bufferedText = "";
    };

    try {
      for await (const event of source as AsyncIterable<unknown>) {
        const record = toRecord(event);
        const type = typeof record?.type === "string" ? record.type : "";

        if (type === "text_start" || type === "text_delta" || type === "text_end") {
          bufferedTextEvents.push(event);
          if (typeof record?.delta === "string") {
            bufferedText += record.delta;
          } else if (typeof record?.content === "string" && !bufferedText) {
            bufferedText = record.content;
          }
          if (!couldStillBePlainTextToolCall(bufferedText)) {
            flushBufferedTextEvents();
          }
          continue;
        }

        if (type === "done") {
          const promotedMessage = promotePlainTextToolCalls(record?.message, toolNames);
          if (promotedMessage) {
            bufferedTextEvents.splice(0);
            bufferedText = "";
            emitPromotedToolCallEvents(stream, promotedMessage);
            stream.push({ ...record, reason: "toolUse", message: promotedMessage });
          } else {
            flushBufferedTextEvents();
            stream.push(event);
          }
          endStream();
          return;
        }

        flushBufferedTextEvents();
        stream.push(event);
        if (type === "error") {
          endStream();
          return;
        }
      }
      flushBufferedTextEvents();
    } catch (error) {
      stream.push({
        type: "error",
        reason: "error",
        error: {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: error instanceof Error ? error.message : String(error),
        },
      });
    } finally {
      endStream();
    }
  })();

  return output as ReturnType<StreamFn>;
}

/**
 * Bundled-provider runtime hygiene for providers that can leak tool-use syntax
 * as assistant text even when native tool calling is enabled.
 */
export function createPlainTextToolCallPromotionWrapper(
  baseStreamFn: StreamFn | undefined,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    const maybeStream = underlying(model, context, options);
    if (maybeStream && typeof maybeStream === "object" && "then" in maybeStream) {
      return Promise.resolve(maybeStream).then((stream) =>
        wrapPlainTextToolCallStream(stream, context),
      ) as ReturnType<StreamFn>;
    }
    return wrapPlainTextToolCallStream(maybeStream, context);
  };
}
