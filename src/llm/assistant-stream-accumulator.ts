import type {
  AssistantMessage,
  AssistantMessageEvent,
  StopReason,
  TextContent,
  ThinkingContent,
  ToolCall,
  Usage,
} from "./types.js";

export type AssistantStreamAccumulatorModel = Pick<AssistantMessage, "api" | "provider" | "model">;

export type AssistantStreamDeltaPartialMode = "empty" | "snapshot";

export interface AssistantStreamAccumulatorOptions {
  model: AssistantStreamAccumulatorModel;
  usage?: Usage;
  timestamp?: number;
  deltaPartialMode?: AssistantStreamDeltaPartialMode;
}

type AssistantContent = AssistantMessage["content"][number];

const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function cloneContentBlock(block: AssistantContent): AssistantContent {
  return { ...block };
}

function cloneContent(content: AssistantContent[]): AssistantMessage["content"] {
  return content.map(cloneContentBlock);
}

function ensureTextContent(
  content: AssistantContent[],
  contentIndex: number,
  eventType: string,
): TextContent {
  const block = content[contentIndex];
  if (block?.type !== "text") {
    throw new Error(`Received ${eventType} for non-text content`);
  }
  return block;
}

function ensureThinkingContent(
  content: AssistantContent[],
  contentIndex: number,
  eventType: string,
): ThinkingContent {
  const block = content[contentIndex];
  if (block?.type !== "thinking") {
    throw new Error(`Received ${eventType} for non-thinking content`);
  }
  return block;
}

function ensureToolCallContent(
  content: AssistantContent[],
  contentIndex: number,
  eventType: string,
): ToolCall {
  const block = content[contentIndex];
  if (block?.type !== "toolCall") {
    throw new Error(`Received ${eventType} for non-toolCall content`);
  }
  return block;
}

export function createAssistantStreamAccumulator(options: AssistantStreamAccumulatorOptions) {
  const content: AssistantContent[] = [];
  const usage = options.usage ?? ZERO_USAGE;
  const timestamp = options.timestamp ?? Date.now();
  const deltaPartialMode = options.deltaPartialMode ?? "empty";

  const buildMessage = (
    nextContent: AssistantContent[],
    overrides: {
      stopReason?: StopReason;
      usage?: Usage;
      errorMessage?: string;
      timestamp?: number;
    } = {},
  ): AssistantMessage => ({
    role: "assistant",
    content: cloneContent(nextContent),
    api: options.model.api,
    provider: options.model.provider,
    model: options.model.model,
    stopReason: overrides.stopReason ?? "stop",
    ...(overrides.errorMessage ? { errorMessage: overrides.errorMessage } : {}),
    usage: overrides.usage ?? usage,
    timestamp: overrides.timestamp ?? timestamp,
  });

  const boundaryPartial = (): AssistantMessage => buildMessage(content);
  const deltaPartial = (): AssistantMessage =>
    deltaPartialMode === "snapshot" ? boundaryPartial() : buildMessage([]);

  const accumulator = {
    start(): Extract<AssistantMessageEvent, { type: "start" }> {
      return { type: "start", partial: boundaryPartial() };
    },

    startText(contentIndex: number): Extract<AssistantMessageEvent, { type: "text_start" }> {
      content[contentIndex] = { type: "text", text: "" };
      return { type: "text_start", contentIndex, partial: boundaryPartial() };
    },

    appendTextDelta(
      contentIndex: number,
      delta: string,
      options: { replace?: boolean } = {},
    ): Extract<AssistantMessageEvent, { type: "text_delta" }> {
      const block = ensureTextContent(content, contentIndex, "text_delta");
      block.text = options.replace ? delta : block.text + delta;
      return {
        type: "text_delta",
        contentIndex,
        delta,
        ...(options.replace ? { replace: true } : {}),
        partial: deltaPartial(),
      };
    },

    endText(
      contentIndex: number,
      options: { textSignature?: string } = {},
    ): Extract<AssistantMessageEvent, { type: "text_end" }> {
      const block = ensureTextContent(content, contentIndex, "text_end");
      if (options.textSignature !== undefined) {
        block.textSignature = options.textSignature;
      }
      return {
        type: "text_end",
        contentIndex,
        content: block.text,
        partial: boundaryPartial(),
      };
    },

    startThinking(
      contentIndex: number,
    ): Extract<AssistantMessageEvent, { type: "thinking_start" }> {
      content[contentIndex] = { type: "thinking", thinking: "" };
      return { type: "thinking_start", contentIndex, partial: boundaryPartial() };
    },

    appendThinkingDelta(
      contentIndex: number,
      delta: string,
    ): Extract<AssistantMessageEvent, { type: "thinking_delta" }> {
      const block = ensureThinkingContent(content, contentIndex, "thinking_delta");
      block.thinking += delta;
      return {
        type: "thinking_delta",
        contentIndex,
        delta,
        partial: deltaPartial(),
      };
    },

    endThinking(
      contentIndex: number,
      options: { thinkingSignature?: string } = {},
    ): Extract<AssistantMessageEvent, { type: "thinking_end" }> {
      const block = ensureThinkingContent(content, contentIndex, "thinking_end");
      if (options.thinkingSignature !== undefined) {
        block.thinkingSignature = options.thinkingSignature;
      }
      return {
        type: "thinking_end",
        contentIndex,
        content: block.thinking,
        partial: boundaryPartial(),
      };
    },

    startToolCall(
      contentIndex: number,
      toolCall: ToolCall,
    ): Extract<AssistantMessageEvent, { type: "toolcall_start" }> {
      content[contentIndex] = { ...toolCall };
      return { type: "toolcall_start", contentIndex, partial: boundaryPartial() };
    },

    appendToolCallDelta(
      contentIndex: number,
      delta: string,
      update?: (toolCall: ToolCall) => void,
    ): Extract<AssistantMessageEvent, { type: "toolcall_delta" }> {
      const block = ensureToolCallContent(content, contentIndex, "toolcall_delta");
      update?.(block);
      return {
        type: "toolcall_delta",
        contentIndex,
        delta,
        partial: deltaPartial(),
      };
    },

    endToolCall(
      contentIndex: number,
      update?: (toolCall: ToolCall) => void,
    ): Extract<AssistantMessageEvent, { type: "toolcall_end" }> {
      const block = ensureToolCallContent(content, contentIndex, "toolcall_end");
      update?.(block);
      return {
        type: "toolcall_end",
        contentIndex,
        toolCall: { ...block },
        partial: boundaryPartial(),
      };
    },

    message(overrides: { stopReason?: StopReason; usage?: Usage; errorMessage?: string } = {}) {
      return buildMessage(content, overrides);
    },

    done(
      reason: Extract<StopReason, "stop" | "length" | "toolUse">,
      options: { usage?: Usage } = {},
    ): Extract<AssistantMessageEvent, { type: "done" }> {
      return {
        type: "done",
        reason,
        message: buildMessage(content, { stopReason: reason, usage: options.usage }),
      };
    },

    error(
      reason: Extract<StopReason, "aborted" | "error">,
      options: { errorMessage?: string; usage?: Usage } = {},
    ): Extract<AssistantMessageEvent, { type: "error" }> {
      return {
        type: "error",
        reason,
        error: buildMessage(content, {
          stopReason: reason,
          errorMessage: options.errorMessage,
          usage: options.usage,
        }),
      };
    },
  };

  return accumulator;
}
