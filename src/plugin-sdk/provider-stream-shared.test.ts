import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { AssistantMessage, Model } from "openclaw/plugin-sdk/llm";
import { createZeroUsageFixture } from "openclaw/plugin-sdk/test-fixtures";
import { expect, it, vi } from "vitest";
import { createAssistantMessageEventStream } from "../llm/utils/event-stream.js";
import {
  createDeepSeekV4OpenAICompatibleThinkingWrapper,
  createAnthropicThinkingPrefillPayloadWrapper,
  createOpenAICompatibleCompletionsThinkingOffWrapper,
  createPayloadPatchStreamWrapper,
  createPlainTextToolCallCompatWrapper,
  defaultToolStreamExtraParams,
  isOpenAICompatibleThinkingEnabled,
  normalizeOpenAICompatibleReasoningPayload,
  normalizeOpenAICompatibleReasoningReplay,
  setQwenChatTemplateThinking,
  stripTrailingAnthropicAssistantPrefillWhenThinking,
  transformProviderStreamMessages,
} from "./provider-stream-shared.js";

type StreamEvent = { type: string } & Record<string, unknown>;

type AssistantContent = string | Array<Record<string, unknown>>;

function textBlock(text: string) {
  return { type: "text", text };
}

type MessageFixture = Record<string, unknown> & { content?: AssistantContent; stopReason?: string };
type EventFixture = Record<string, unknown> & {
  type: string;
  partial?: MessageFixture;
  message?: MessageFixture;
  error?: MessageFixture;
};

function completeAssistantMessage(value: MessageFixture, fallbackStopReason = "stop") {
  return {
    ...value,
    role: "assistant",
    content: typeof value.content === "string" ? [textBlock(value.content)] : (value.content ?? []),
    api: "openai-completions",
    provider: "test",
    model: "test-model",
    usage: createZeroUsageFixture(),
    stopReason: value.stopReason ?? fallbackStopReason,
    timestamp: 1,
  };
}

function completeStreamEvent(event: EventFixture) {
  const requiresPartial = !["text_delta", "done", "error"].includes(event.type);
  return {
    ...event,
    ...(event.partial || requiresPartial
      ? { partial: completeAssistantMessage(event.partial ?? { content: [] }) }
      : {}),
    ...(event.message
      ? { message: completeAssistantMessage(event.message, String(event.reason)) }
      : {}),
    ...(event.error ? { error: completeAssistantMessage(event.error, "error") } : {}),
  };
}

function thinkingBlock(thinking = "Need file contents.") {
  return { type: "thinking", thinking };
}
function thinkingDelta(content: Array<Record<string, unknown>>, contentIndex: number) {
  return {
    type: "thinking_delta",
    contentIndex,
    delta: "Need file contents.",
    partial: { content },
  };
}
function payloadStream(payload: Record<string, unknown>): StreamFn {
  return (model, _context, options) => {
    options?.onPayload?.(payload as never, model as never);
    return {} as ReturnType<StreamFn>;
  };
}
function prefillPayload(type: string) {
  return {
    thinking: { type },
    messages: [
      { role: "user", content: "Return JSON." },
      { role: "assistant", content: "{" },
    ],
  };
}

function expectEventTypes(events: StreamEvent[], types: string) {
  expect(events.map((event) => event.type)).toEqual(types.split(" "));
}

function textDelta(delta: string) {
  return { type: "text_delta", contentIndex: 0, delta };
}

function doneEvent(content: AssistantContent, reason = "stop") {
  return {
    type: "done",
    reason,
    message: completeAssistantMessage({ content, stopReason: reason }),
  };
}

function errorEvent(error: MessageFixture, partial?: MessageFixture) {
  return {
    type: "error",
    reason: "error",
    ...(partial ? { partial: completeAssistantMessage(partial, "error") } : {}),
    error: completeAssistantMessage(error, "error"),
  };
}

const streamTestModel = {
  id: "test-model",
  name: "Test Model",
  api: "openai-completions",
  provider: "test",
  baseUrl: "https://example.test/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8_192,
  maxTokens: 1_024,
} satisfies Model<"openai-completions">;

function localModel(id: string, compat?: Model<"openai-completions">["compat"]) {
  return {
    ...streamTestModel,
    provider: "lmstudio",
    id,
    baseUrl: "http://127.0.0.1:1234/v1",
    reasoning: true,
    ...(compat ? { compat } : {}),
  };
}
const lmstudioBareModel = localModel("qwen3-8b-instruct");
const lmstudioBinaryModel = localModel("google/gemma-4-26b-a4b-qat", {
  supportsReasoningEffort: true,
  supportedReasoningEfforts: ["none", "minimal", "low", "medium", "high", "xhigh"],
  reasoningEffortMap: { off: "none", none: "none", adaptive: "xhigh", max: "xhigh" },
});

function createPayloadCapture(initialReasoningEffort?: string) {
  const payloads: Array<Record<string, unknown>> = [];
  const baseStreamFn: StreamFn = (model, _context, options) => {
    const payload: Record<string, unknown> = { model: model.id };
    if (initialReasoningEffort !== undefined) {
      payload.reasoning_effort = initialReasoningEffort;
    }
    options?.onPayload?.(payload, model);
    payloads.push(structuredClone(payload));
    return createAssistantMessageEventStream();
  };
  return { baseStreamFn, payloads };
}

async function collectEvents(events: EventFixture[], toolNames = ["read"]): Promise<StreamEvent[]> {
  const outputSource = createAssistantMessageEventStream();
  queueMicrotask(() => {
    for (const event of events) {
      outputSource.push(completeStreamEvent(event) as never);
    }
    outputSource.end();
  });
  const wrapped = createPlainTextToolCallCompatWrapper(() => outputSource);
  const stream = await wrapped(
    streamTestModel,
    { tools: toolNames.map((name) => ({ name })) } as never,
    {},
  );
  const output: StreamEvent[] = [];
  for await (const event of stream as AsyncIterable<unknown>) {
    output.push(event as StreamEvent);
  }
  return output;
}

async function nextEvent(iterator: AsyncIterator<unknown>, label: string): Promise<StreamEvent> {
  const result = await Promise.race([
    iterator.next(),
    new Promise<"timed out">((resolve) => {
      setTimeout(() => resolve("timed out"), 50);
    }),
  ]);
  if (result === "timed out") {
    throw new Error(`timed out waiting for ${label}`);
  }
  expect(result.done).toBe(false);
  return result.value as StreamEvent;
}

it("transformProviderStreamMessages: transforms checkpoint and done result messages while preserving sparse deltas", async () => {
  const partial: AssistantMessage = {
    role: "assistant",
    api: "openai-completions",
    provider: "test",
    model: "test-model",
    content: [],
    usage: createZeroUsageFixture(),
    stopReason: "stop",
    timestamp: 1,
  };
  const final: AssistantMessage = {
    ...partial,
    usage: createZeroUsageFixture(),
  };
  const source = createAssistantMessageEventStream();
  source.push({ type: "start", partial });
  source.push({ type: "text_delta", contentIndex: 0, delta: "reply" });
  source.push({ type: "done", reason: "stop", message: final });
  source.end();
  const stream = transformProviderStreamMessages(source, (message) => {
    message.usage.cacheTelemetry = { state: "available" };
  });
  const eventTypes: string[] = [];
  for await (const event of stream) {
    eventTypes.push(event.type);
    if (event.type === "text_delta") {
      expect(event).toEqual({ type: "text_delta", contentIndex: 0, delta: "reply" });
    }
  }
  expect(eventTypes).toEqual(["start", "text_delta", "done"]);
  expect(partial.usage.cacheTelemetry).toEqual({ state: "available" });
  expect(final.usage.cacheTelemetry).toEqual({ state: "available" });
  expect((await stream.result()).usage.cacheTelemetry).toEqual({ state: "available" });
});

it("defaultToolStreamExtraParams: defaults tool_stream on when absent", () => {
  expect(defaultToolStreamExtraParams()).toEqual({ tool_stream: true });
  expect(defaultToolStreamExtraParams({ fastMode: true })).toEqual({
    fastMode: true,
    tool_stream: true,
  });
});

it("defaultToolStreamExtraParams: preserves explicit tool_stream values", () => {
  const enabled = { tool_stream: true, fastMode: true };
  const disabled = { tool_stream: false, fastMode: true };

  expect(defaultToolStreamExtraParams(enabled)).toBe(enabled);
  expect(defaultToolStreamExtraParams(disabled)).toBe(disabled);
});

it.each([
  { thinkingLevel: undefined, options: {}, enabled: true },
  { thinkingLevel: "off", options: { reasoning: { effort: "off" } }, enabled: true },
] as const)(
  "isOpenAICompatibleThinkingEnabled: resolves thinking $thinkingLevel with request $options to $enabled",
  ({ thinkingLevel, options, enabled }) => {
    expect(isOpenAICompatibleThinkingEnabled({ thinkingLevel, options: options as never })).toBe(
      enabled,
    );
  },
);

it.each([true, false])(
  "setQwenChatTemplateThinking: preserves kwargs when present, enabled=%s",
  (enabled) => {
    const payload: Record<string, unknown> = enabled
      ? { chat_template_kwargs: { custom_flag: "keep", preserve_thinking: false } }
      : {};
    setQwenChatTemplateThinking(payload, enabled);
    expect(payload).toEqual({
      chat_template_kwargs: enabled
        ? { custom_flag: "keep", preserve_thinking: false, enable_thinking: true }
        : { enable_thinking: false, preserve_thinking: true },
    });
  },
);
it.each([{ max_tokens: 256 }, { effort: "low", summary: "auto" }])(
  "normalizeOpenAICompatibleReasoningPayload: preserves explicit %j controls",
  (reasoning) => {
    const payload = { reasoning_effort: "high", reasoning };
    normalizeOpenAICompatibleReasoningPayload(payload, "high");
    expect(payload).toEqual({ reasoning });
  },
);

it("normalizeOpenAICompatibleReasoningReplay: honors provider-owned tool-call replay selection", () => {
  const payload = {
    messages: [
      { role: "assistant", content: "plain" },
      { role: "assistant", tool_calls: [{ id: "call_1" }] },
    ],
  };

  normalizeOpenAICompatibleReasoningReplay(payload, {
    thinkingEnabled: true,
    shouldBackfillAssistantMessage: (message) => Array.isArray(message.tool_calls),
  });

  expect(payload.messages).toEqual([
    { role: "assistant", content: "plain" },
    { role: "assistant", tool_calls: [{ id: "call_1" }], reasoning_content: "" },
  ]);
});

it("normalizeOpenAICompatibleReasoningReplay: normalizes nullable reasoning for providers requiring string replay", () => {
  const payload = {
    messages: [
      { role: "assistant", reasoning_content: null },
      { role: "assistant", reasoning_content: undefined },
    ],
  };

  normalizeOpenAICompatibleReasoningReplay(payload, {
    thinkingEnabled: true,
    replaceNullReasoningContent: true,
  });

  expect(payload.messages).toEqual([
    { role: "assistant", reasoning_content: "" },
    { role: "assistant", reasoning_content: "" },
  ]);
});

it("normalizeOpenAICompatibleReasoningReplay: strips disabled reasoning with assistant-only policy", () => {
  const payload = {
    messages: [
      { role: "user", reasoning_content: "preserve user" },
      { role: "assistant", reasoning_content: "remove assistant" },
      { role: "tool", reasoning_content: "preserve tool" },
    ],
  };
  normalizeOpenAICompatibleReasoningReplay(payload, {
    thinkingEnabled: false,
    stripAssistantMessagesOnly: true,
  });

  expect(payload.messages).toEqual([
    { role: "user", reasoning_content: "preserve user" },
    { role: "assistant" },
    { role: "tool", reasoning_content: "preserve tool" },
  ]);
});

it("createDeepSeekV4OpenAICompatibleThinkingWrapper: backfills reasoning_content on every replayed assistant message when thinking is enabled", () => {
  const payload = {
    messages: [
      { role: "user", content: "read file" },
      { role: "assistant", tool_calls: [{ id: "call_1", name: "read" }] },
      { role: "tool", content: "ok" },
      { role: "assistant", content: "done" },
      { role: "assistant", content: "kept", reasoning_content: "native reasoning" },
    ],
  };
  const baseStreamFn = payloadStream(payload);

  const wrapped = createDeepSeekV4OpenAICompatibleThinkingWrapper({
    baseStreamFn,
    thinkingLevel: "high",
    shouldPatchModel: () => true,
  });
  void wrapped?.({} as never, {} as never, {});

  expect(payload.messages[0]).not.toHaveProperty("reasoning_content");
  expect(payload.messages[1]).toHaveProperty("reasoning_content", "");
  expect(payload.messages[2]).not.toHaveProperty("reasoning_content");
  expect(payload.messages[3]).toHaveProperty("reasoning_content", "");
  expect(payload.messages[4]).toHaveProperty("reasoning_content", "native reasoning");
});

it("createPayloadPatchStreamWrapper: calls the underlying stream directly when shouldPatch rejects the model", () => {
  const baseStreamFn = vi.fn<StreamFn>(() => ({}) as ReturnType<StreamFn>);

  const wrapped = createPayloadPatchStreamWrapper(
    baseStreamFn,
    ({ payload }) => {
      payload.unexpected = true;
    },
    { shouldPatch: () => false },
  );
  void wrapped({ id: "model" } as never, { messages: [] } as never, {});

  expect(baseStreamFn).toHaveBeenCalledOnce();
  expect(baseStreamFn.mock.calls[0]?.[2]?.onPayload).toBeUndefined();
});

it("createOpenAICompatibleCompletionsThinkingOffWrapper: uses per-call thinking before the undefined default", () => {
  const { baseStreamFn, payloads } = createPayloadCapture("high");
  const wrapped = createOpenAICompatibleCompletionsThinkingOffWrapper(baseStreamFn);
  for (const reasoning of ["off", "max", undefined] as const) {
    void wrapped(lmstudioBinaryModel, { messages: [] }, { reasoning });
  }

  expect(payloads.map((payload) => payload.reasoning_effort)).toEqual(["none", "high", "high"]);
});

it.each([
  ["no disabled effort", lmstudioBareModel, "high"],
  ["no effort sent", lmstudioBinaryModel, undefined],
] as const)(
  "createOpenAICompatibleCompletionsThinkingOffWrapper: omits reasoning_effort with %s",
  (_name, model, initialEffort) => {
    const { baseStreamFn, payloads } = createPayloadCapture(initialEffort);
    const wrapped = createOpenAICompatibleCompletionsThinkingOffWrapper(baseStreamFn, "off");
    void wrapped(model, { messages: [] }, {});
    expect(payloads[0]).not.toHaveProperty("reasoning_effort");
  },
);

it("createPlainTextToolCallCompatWrapper: does not promote complete-looking text tool calls after a length stop", async () => {
  const rawToolText = '[tool:read] {"path":"/tmp/file.txt"}';
  const events = await collectEvents([doneEvent(rawToolText, "length")]);

  expectEventTypes(events, "done");
  expect(events.at(-1)).toMatchObject({
    reason: "length",
    message: { content: [textBlock(rawToolText)], stopReason: "length" },
  });
});

it("createPlainTextToolCallCompatWrapper: flushes false-positive buffered prefixes around interleaved events in source order", async () => {
  const firstText = "[tool:re";
  const secondText = " not a call";
  const events = await collectEvents([
    textDelta(firstText),
    thinkingDelta([textBlock(firstText), thinkingBlock()], 1),
    textDelta(secondText),
    doneEvent([textBlock(`${firstText}${secondText}`), thinkingBlock()]),
  ]);

  expectEventTypes(events, "text_delta thinking_delta text_delta done");
  expect(events[0]).toHaveProperty("delta", firstText);
  expect(events[1]).toHaveProperty("partial.content", [textBlock(firstText), thinkingBlock()]);
  expect(events[2]).toHaveProperty("delta", secondText);
});

it("createPlainTextToolCallCompatWrapper: keeps possible tool-call text buffered across interleaved non-text events", async () => {
  const rawToolText = "[tool:read]\n<parameter=path>\nsrc/index.ts\n</parameter>\n</function>";
  const events = await collectEvents([
    { type: "text_delta", contentIndex: 1, delta: rawToolText },
    thinkingDelta([thinkingBlock(), textBlock(rawToolText)], 0),
    doneEvent([thinkingBlock(), textBlock(rawToolText)]),
  ]);

  expectEventTypes(events, "start thinking_delta toolcall_start toolcall_delta toolcall_end done");
  expect(events[1]).toHaveProperty("partial.content", [
    thinkingBlock(),
    expect.objectContaining({ type: "toolCall", name: "read" }),
  ]);
  expect(JSON.stringify(events)).not.toContain(rawToolText);
});

it("createPlainTextToolCallCompatWrapper: scrubs compacted error partials when an emoji crosses the safe prefix boundary", async () => {
  const toolPrefix = "[tool:read]\n<parameter=path>\n";
  const emojiIndex = 255_999;
  const firstChunk = `${toolPrefix}${"x".repeat(emojiIndex - toolPrefix.length)}😀${"y".repeat(70_000)}`;
  const secondChunk = "z".repeat(70_000);
  const rawToolText = firstChunk + secondChunk;
  const events = await collectEvents([
    textDelta(firstChunk),
    textDelta(secondChunk),
    errorEvent(
      { content: [textBlock(rawToolText)], errorMessage: "stream failed" },
      { content: [textBlock(rawToolText)] },
    ),
  ]);

  expectEventTypes(events, "error");
  expect(events[0]).toHaveProperty("partial.content", [textBlock("")]);
  expect(events[0]).toHaveProperty("error.content", []);
  expect(JSON.stringify(events)).not.toContain("[tool:read]");
});

it("createPlainTextToolCallCompatWrapper: scrubs mixed under-cap calls from multi-block errors without partials", async () => {
  const rawCall = "<function=read></function>";
  const visibleText = "Visible answer before the stream error.";
  const rawText = `${rawCall}\n${visibleText}`;
  const events = await collectEvents([
    textDelta(rawText),
    errorEvent({
      role: "assistant",
      content: [textBlock(rawCall), textBlock(visibleText)],
      message: "stream failed",
    }),
  ]);

  expectEventTypes(events, "text_delta error");
  expect(events[0]).toHaveProperty("delta", visibleText);
  expect(events[1]).toHaveProperty("error.content", [textBlock(visibleText)]);
  expect(JSON.stringify(events)).not.toContain("<function=read>");
});

it("createPlainTextToolCallCompatWrapper: promotes split zero-argument XML function calls without leaking partials", async () => {
  const source = createAssistantMessageEventStream();
  const wrapped = createPlainTextToolCallCompatWrapper(() => source);
  const stream = await wrapped(
    streamTestModel,
    {
      messages: [],
      tools: [{ name: "read", description: "Read", parameters: { type: "object" } }],
    } as never,
    {},
  );
  const iterator = stream[Symbol.asyncIterator]();
  const rawToolText = ["<function=read>", "</function>"].join("\n");

  try {
    source.push(completeStreamEvent({ type: "start", partial: { content: [] } }) as never);
    expect((await nextEvent(iterator, "start")).type).toBe("start");

    let streamedText = "";
    for (const delta of ["<", "function=read>\n</func", "tion>"]) {
      streamedText += delta;
      source.push({
        type: "text_delta",
        contentIndex: 0,
        delta,
        partial: { role: "assistant", content: [{ type: "text", text: streamedText }] },
      } as never);
    }
    source.push(doneEvent([textBlock(rawToolText)]) as never);

    const events = [
      await nextEvent(iterator, "zero-argument tool-call start"),
      await nextEvent(iterator, "zero-argument tool-call arguments"),
      await nextEvent(iterator, "zero-argument tool-call end"),
      await nextEvent(iterator, "zero-argument done event"),
    ];
    expectEventTypes(events, "toolcall_start toolcall_delta toolcall_end done");
    expect(events[1]).toMatchObject({ delta: "{}" });
    expect(events[3]).toMatchObject({
      reason: "toolUse",
      message: {
        content: [{ type: "toolCall", name: "read", arguments: {} }],
        stopReason: "toolUse",
      },
    });
    expect(JSON.stringify(events)).not.toContain("<function");
    expect(JSON.stringify(events)).not.toContain("</function>");
  } finally {
    source.end();
    await iterator.return?.();
  }
});

it.each([
  { content: [{ type: "tool_use", id: "toolu_1", name: "Read" }] },
  { content: [{ type: "toolCall", id: "call_1", name: "Read" }] },
  { tool_calls: [{ id: "call_1", name: "Read" }] },
])(
  "stripTrailingAnthropicAssistantPrefillWhenThinking: preserves assistant tool-use turns in %j",
  (message) => {
    const payload = {
      thinking: { type: "adaptive" },
      messages: [{ role: "assistant", ...message }],
    };
    expect(stripTrailingAnthropicAssistantPrefillWhenThinking(payload)).toBe(0);
  },
);
it("stripTrailingAnthropicAssistantPrefillWhenThinking: keeps assistant prefill when Anthropic thinking is disabled", () => {
  const payload = prefillPayload("disabled");

  expect(stripTrailingAnthropicAssistantPrefillWhenThinking(payload)).toBe(0);
  expect(payload.messages).toHaveLength(2);
});

it("createAnthropicThinkingPrefillPayloadWrapper: reports stripped assistant prefill count", () => {
  const payload = prefillPayload("enabled");
  let strippedCount = 0;
  const baseStreamFn = payloadStream(payload);

  const wrapped = createAnthropicThinkingPrefillPayloadWrapper(
    baseStreamFn,
    (stripped) => {
      strippedCount = stripped;
    },
    { shouldPatch: ({ model }) => model.api === "anthropic-messages" },
  );
  void wrapped({ api: "anthropic-messages" } as never, {} as never, {});

  expect(payload.messages).toEqual([{ role: "user", content: "Return JSON." }]);
  expect(strippedCount).toBe(1);
});
