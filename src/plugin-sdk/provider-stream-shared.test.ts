import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { Model } from "openclaw/plugin-sdk/llm";
import { createRequireRecord, createZeroUsageFixture } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it } from "vitest";
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
} from "./provider-stream-shared.js";

type StreamEvent = { type: string } & Record<string, unknown>;

type AssistantContent = string | Array<Record<string, unknown>>;

function textBlock(text: string) {
  return { type: "text", text };
}

function completeAssistantMessage(
  value: Record<string, unknown>,
  fallbackStopReason = "stop",
): Record<string, unknown> {
  const content =
    typeof value.content === "string"
      ? [textBlock(value.content)]
      : Array.isArray(value.content)
        ? value.content
        : [];
  return {
    ...value,
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "test",
    model: "test-model",
    usage: createZeroUsageFixture(),
    stopReason: typeof value.stopReason === "string" ? value.stopReason : fallbackStopReason,
    timestamp: 1,
  };
}

function completeStreamEvent(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const event = value as Record<string, unknown>;
  const requiresPartial =
    event.type === "start" ||
    (typeof event.type === "string" &&
      event.type !== "text_delta" &&
      event.type !== "done" &&
      event.type !== "error");
  const partial =
    event.partial && typeof event.partial === "object" && !Array.isArray(event.partial)
      ? completeAssistantMessage(event.partial as Record<string, unknown>)
      : requiresPartial
        ? completeAssistantMessage({ content: [] })
        : undefined;
  const message =
    event.message && typeof event.message === "object" && !Array.isArray(event.message)
      ? completeAssistantMessage(event.message as Record<string, unknown>, String(event.reason))
      : undefined;
  const error =
    event.error && typeof event.error === "object" && !Array.isArray(event.error)
      ? completeAssistantMessage(event.error as Record<string, unknown>, "error")
      : undefined;
  return {
    ...event,
    ...(partial ? { partial } : {}),
    ...(message ? { message } : {}),
    ...(error ? { error } : {}),
  };
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

function errorEvent(error: Record<string, unknown>, partial?: Record<string, unknown>) {
  return {
    type: "error",
    reason: "error",
    ...(partial ? { partial: completeAssistantMessage(partial, "error") } : {}),
    error: completeAssistantMessage(error, "error"),
  };
}

const lmstudioBinaryModel = {
  api: "openai-completions",
  provider: "lmstudio",
  id: "google/gemma-4-26b-a4b-qat",
  baseUrl: "http://127.0.0.1:1234/v1",
  reasoning: true,
  compat: {
    supportsReasoningEffort: true,
    supportedReasoningEfforts: ["none", "minimal", "low", "medium", "high", "xhigh"],
    reasoningEffortMap: { off: "none", none: "none", adaptive: "xhigh", max: "xhigh" },
  },
} as unknown as Model<"openai-completions">;

const lmstudioBareModel = {
  api: "openai-completions",
  provider: "lmstudio",
  id: "qwen3-8b-instruct",
  baseUrl: "http://127.0.0.1:1234/v1",
  reasoning: true,
} as unknown as Model<"openai-completions">;

const requireRecord = createRequireRecord("record", "expected-label-record");

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

function messageOf(event: unknown) {
  return requireRecord(requireRecord(event, "done event").message, "done message");
}

function createEventStream(events: unknown[]): ReturnType<StreamFn> {
  const output = createAssistantMessageEventStream();
  const stream = output as unknown as { push(event: unknown): void; end(): void };
  queueMicrotask(() => {
    for (const event of events) {
      stream.push(completeStreamEvent(event));
    }
    stream.end();
  });
  return output as ReturnType<StreamFn>;
}

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

function createControlledPlainTextToolCallCompatStream() {
  const source = createAssistantMessageEventStream();
  const baseStream: StreamFn = () => source as ReturnType<StreamFn>;
  const wrapped = createPlainTextToolCallCompatWrapper(baseStream);
  const stream = wrapped(
    streamTestModel,
    {
      messages: [],
      tools: [{ name: "read", description: "Read", parameters: { type: "object" } }],
    } as never,
    {},
  );
  return { source, stream };
}

async function collectEvents(events: unknown[], toolNames = ["read"]): Promise<StreamEvent[]> {
  const wrapped = createPlainTextToolCallCompatWrapper(() => createEventStream(events));
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

async function collectTextDoneEvents(deltas: string[], rawText: string) {
  return collectEvents([
    ...deltas.map((delta) => textDelta(delta)),
    doneEvent([textBlock(rawText)]),
  ]);
}

async function collectResult(events: unknown[]) {
  const { source, stream } = createControlledPlainTextToolCallCompatStream();
  const output = await stream;
  const resultPromise = output.result();
  for (const event of events) {
    source.push(completeStreamEvent(event) as never);
  }
  source.end();
  return requireRecord(await resultPromise, "result message");
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

describe("defaultToolStreamExtraParams", () => {
  it("defaults tool_stream on when absent", () => {
    expect(defaultToolStreamExtraParams()).toEqual({ tool_stream: true });
    expect(defaultToolStreamExtraParams({ fastMode: true })).toEqual({
      fastMode: true,
      tool_stream: true,
    });
  });

  it("preserves explicit tool_stream values", () => {
    const enabled = { tool_stream: true, fastMode: true };
    const disabled = { tool_stream: false, fastMode: true };

    expect(defaultToolStreamExtraParams(enabled)).toBe(enabled);
    expect(defaultToolStreamExtraParams(disabled)).toBe(disabled);
  });
});

describe("isOpenAICompatibleThinkingEnabled", () => {
  it.each([
    { thinkingLevel: "high", options: { reasoning: "none" }, enabled: false },
    { thinkingLevel: "off", options: { reasoningEffort: "medium" }, enabled: true },
    { thinkingLevel: "off", options: {}, enabled: false },
    { thinkingLevel: undefined, options: {}, enabled: true },
    { thinkingLevel: "off", options: { reasoning: { effort: "off" } }, enabled: true },
  ] as const)(
    "resolves thinking $thinkingLevel with request $options to $enabled",
    ({ thinkingLevel, options, enabled }) => {
      expect(isOpenAICompatibleThinkingEnabled({ thinkingLevel, options: options as never })).toBe(
        enabled,
      );
    },
  );
});

describe("setQwenChatTemplateThinking", () => {
  it("preserves existing chat-template kwargs and enables thinking", () => {
    const payload = {
      chat_template_kwargs: {
        custom_flag: "keep",
        preserve_thinking: false,
      },
    };

    setQwenChatTemplateThinking(payload, true);

    expect(payload.chat_template_kwargs).toEqual({
      custom_flag: "keep",
      preserve_thinking: false,
      enable_thinking: true,
    });
  });

  it("creates the required chat-template kwargs when absent", () => {
    const payload: Record<string, unknown> = {};

    setQwenChatTemplateThinking(payload, false);

    expect(payload).toEqual({
      chat_template_kwargs: {
        enable_thinking: false,
        preserve_thinking: true,
      },
    });
  });
});

describe("normalizeOpenAICompatibleReasoningPayload", () => {
  it("removes the legacy field and adds the selected reasoning effort", () => {
    const payload: Record<string, unknown> = {
      reasoning_effort: "high",
    };

    normalizeOpenAICompatibleReasoningPayload(payload, "adaptive");

    expect(payload).toEqual({ reasoning: { effort: "medium" } });
  });

  it("preserves explicit reasoning controls", () => {
    const withMaxTokens: Record<string, unknown> = {
      reasoning_effort: "high",
      reasoning: { max_tokens: 256 },
    };
    const withEffort: Record<string, unknown> = {
      reasoning_effort: "high",
      reasoning: { effort: "low", summary: "auto" },
    };

    normalizeOpenAICompatibleReasoningPayload(withMaxTokens, "high");
    normalizeOpenAICompatibleReasoningPayload(withEffort, "high");

    expect(withMaxTokens).toEqual({ reasoning: { max_tokens: 256 } });
    expect(withEffort).toEqual({ reasoning: { effort: "low", summary: "auto" } });
  });

  it("removes only the legacy field when thinking is disabled", () => {
    const payload: Record<string, unknown> = {
      reasoning_effort: "high",
    };

    normalizeOpenAICompatibleReasoningPayload(payload, "off");

    expect(payload).toEqual({});
  });
});

describe("normalizeOpenAICompatibleReasoningReplay", () => {
  it("honors provider-owned tool-call replay selection", () => {
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

  it("normalizes nullable reasoning for providers requiring string replay", () => {
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

  it.each([false, true])(
    "strips disabled reasoning with assistant-only policy %s",
    (stripAssistantMessagesOnly) => {
      const payload = {
        messages: [
          { role: "user", reasoning_content: "preserve user" },
          { role: "assistant", reasoning_content: "remove assistant" },
          { role: "tool", reasoning_content: "preserve tool" },
        ],
      };
      normalizeOpenAICompatibleReasoningReplay(payload, {
        thinkingEnabled: false,
        stripAssistantMessagesOnly,
      });

      expect(payload.messages).toEqual(
        stripAssistantMessagesOnly
          ? [
              { role: "user", reasoning_content: "preserve user" },
              { role: "assistant" },
              { role: "tool", reasoning_content: "preserve tool" },
            ]
          : [{ role: "user" }, { role: "assistant" }, { role: "tool" }],
      );
    },
  );
});

describe("createDeepSeekV4OpenAICompatibleThinkingWrapper", () => {
  it("backfills reasoning_content on every replayed assistant message when thinking is enabled", () => {
    const payload = {
      messages: [
        { role: "user", content: "read file" },
        { role: "assistant", tool_calls: [{ id: "call_1", name: "read" }] },
        { role: "tool", content: "ok" },
        { role: "assistant", content: "done" },
        { role: "assistant", content: "kept", reasoning_content: "native reasoning" },
      ],
    };
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      options?.onPayload?.(payload as never, _model as never);
      return {} as ReturnType<StreamFn>;
    };

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
});

describe("createPayloadPatchStreamWrapper", () => {
  it("passes stream call options to payload patches", () => {
    let captured: Record<string, unknown> = {};
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      const payload: Record<string, unknown> = {};
      options?.onPayload?.(payload, _model);
      captured = payload;
      return {} as ReturnType<StreamFn>;
    };

    const wrapped = createPayloadPatchStreamWrapper(baseStreamFn, ({ payload, options }) => {
      payload.reasoning = options?.reasoning;
    });
    void wrapped(streamTestModel, { messages: [] }, { reasoning: "medium" });

    expect(captured).toEqual({ reasoning: "medium" });
  });

  it("calls the underlying stream directly when shouldPatch rejects the model", () => {
    let onPayloadWasInstalled = false;
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      onPayloadWasInstalled = typeof options?.onPayload === "function";
      return {} as ReturnType<StreamFn>;
    };

    const wrapped = createPayloadPatchStreamWrapper(
      baseStreamFn,
      ({ payload }) => {
        payload.unexpected = true;
      },
      { shouldPatch: () => false },
    );
    void wrapped({ id: "model" } as never, { messages: [] } as never, {});

    expect(onPayloadWasInstalled).toBe(false);
  });
});

describe("createOpenAICompatibleCompletionsThinkingOffWrapper", () => {
  it.each([
    { thinkingLevel: undefined, efforts: ["none", "high", "high"] },
    { thinkingLevel: "off", efforts: ["none", "high", "none"] },
  ] as const)(
    "uses per-call thinking before the $thinkingLevel default",
    ({ thinkingLevel, efforts }) => {
      const { baseStreamFn, payloads } = createPayloadCapture("high");
      const wrapped = createOpenAICompatibleCompletionsThinkingOffWrapper(
        baseStreamFn,
        thinkingLevel,
      );
      for (const reasoning of ["off", "max", undefined] as const) {
        void wrapped(lmstudioBinaryModel, { messages: [] }, { reasoning });
      }

      expect(payloads.map((payload) => payload.reasoning_effort)).toEqual(efforts);
    },
  );

  it("preserves native none unless the request selects the configured off mapping", () => {
    const { baseStreamFn, payloads } = createPayloadCapture("none");
    const wrapped = createOpenAICompatibleCompletionsThinkingOffWrapper(baseStreamFn, "off");
    for (const reasoning of ["off", "max", undefined] as const) {
      void wrapped(
        {
          ...lmstudioBinaryModel,
          compat: {
            supportedReasoningEfforts: ["none", "low", "high"],
            reasoningEffortMap: { off: "low", none: "none" },
          },
        },
        { messages: [] },
        { reasoning },
      );
    }

    expect(payloads.map((payload) => payload.reasoning_effort)).toEqual(["low", "none", "low"]);
  });

  it("drops reasoning_effort when the model has no disabled effort", () => {
    const { baseStreamFn, payloads } = createPayloadCapture("high");
    const wrapped = createOpenAICompatibleCompletionsThinkingOffWrapper(baseStreamFn, "off");
    void wrapped(lmstudioBareModel, { messages: [] }, {});

    expect(payloads[0]).not.toHaveProperty("reasoning_effort");
  });

  it("does not add reasoning_effort when none was sent", () => {
    const { baseStreamFn, payloads } = createPayloadCapture();
    const wrapped = createOpenAICompatibleCompletionsThinkingOffWrapper(baseStreamFn, "off");
    void wrapped(lmstudioBinaryModel, { messages: [] }, {});

    expect(payloads[0]).not.toHaveProperty("reasoning_effort");
  });
});

describe("createPlainTextToolCallCompatWrapper", () => {
  it("does not promote complete-looking text tool calls after a length stop", async () => {
    const rawToolText = '[tool:read] {"path":"/tmp/file.txt"}';
    const events = await collectEvents([doneEvent(rawToolText, "length")]);

    expect(events.map((event) => event.type)).toEqual(["done"]);
    const done = events.at(-1) as {
      reason?: unknown;
      message?: { content?: unknown; stopReason?: unknown };
    };
    expect(done.reason).toBe("length");
    expect(done.message).toMatchObject({
      content: [textBlock(rawToolText)],
      stopReason: "length",
    });
  });

  it("passes through bracketed text when no configured tool names match", async () => {
    const events = await collectEvents([
      { type: "text_delta", delta: "[note] keep streaming" },
      doneEvent("[note] keep streaming"),
    ]);

    expect(events.map((event) => event.type)).toEqual(["text_delta", "done"]);
  });

  it("flushes false-positive buffered prefixes around interleaved events in source order", async () => {
    const firstText = "[tool:re";
    const secondText = " not a call";
    const events = await collectEvents([
      { type: "text_delta", contentIndex: 0, delta: firstText },
      {
        type: "thinking_delta",
        contentIndex: 1,
        delta: "Need file contents.",
        partial: {
          content: [
            { type: "text", text: firstText },
            { type: "thinking", thinking: "Need file contents." },
          ],
        },
      },
      { type: "text_delta", contentIndex: 0, delta: secondText },
      doneEvent([
        textBlock(`${firstText}${secondText}`),
        { type: "thinking", thinking: "Need file contents." },
      ]),
    ]);

    expect(events.map((event) => event.type)).toEqual([
      "text_delta",
      "thinking_delta",
      "text_delta",
      "done",
    ]);
    expect(requireRecord(events[0], "first text").delta).toBe(firstText);
    const thinkingEvent = requireRecord(events[1], "thinking event");
    expect(requireRecord(thinkingEvent.partial, "thinking partial").content).toEqual([
      { type: "text", text: firstText },
      { type: "thinking", thinking: "Need file contents." },
    ]);
    expect(requireRecord(events[2], "second text").delta).toBe(secondText);
  });

  it("converts standalone plain-text tool calls for result consumers", async () => {
    const rawToolText = '[tool:read] {"path":"src/index.ts"}';
    const message = await collectResult([
      { type: "start", partial: { content: [] } },
      textDelta(rawToolText),
      doneEvent([textBlock(rawToolText)]),
    ]);
    expect(message.stopReason).toBe("toolUse");
    expect(requireRecord((message.content as unknown[])[0], "tool call")).toMatchObject({
      type: "toolCall",
      name: "read",
      arguments: { path: "src/index.ts" },
    });
  });

  it("keeps possible tool-call text buffered across interleaved non-text events", async () => {
    const rawToolText = "[tool:read]\n<parameter=path>\nsrc/index.ts\n</parameter>\n</function>";
    const events = await collectEvents([
      { type: "text_delta", contentIndex: 1, delta: rawToolText },
      {
        type: "thinking_delta",
        contentIndex: 0,
        delta: "Need file contents.",
        partial: {
          content: [
            { type: "thinking", thinking: "Need file contents." },
            { type: "text", text: rawToolText },
          ],
        },
      },
      doneEvent([{ type: "thinking", thinking: "Need file contents." }, textBlock(rawToolText)]),
    ]);

    expect(events.map((event) => event.type)).toEqual([
      "start",
      "thinking_delta",
      "toolcall_start",
      "toolcall_delta",
      "toolcall_end",
      "done",
    ]);
    const thinkingEvent = requireRecord(events[1], "thinking event");
    expect(requireRecord(thinkingEvent.partial, "thinking partial").content).toEqual([
      { type: "thinking", thinking: "Need file contents." },
      expect.objectContaining({ type: "toolCall", name: "read" }),
    ]);
    expect(JSON.stringify(events)).not.toContain(rawToolText);
  });

  it("keeps a byte-over-cap visible suffix at its streamed content index in done messages", async () => {
    const marker = "<function=read>";
    const visibleText = "Visible answer";
    const firstChunk = `${marker}${"\u00a0".repeat(100_000)}`;
    const secondChunk = `${"\u00a0".repeat(28_001)}</function>\n${visibleText}`;
    const content = [
      { type: "text", text: firstChunk },
      { type: "thinking", thinking: "checking" },
      { type: "text", text: secondChunk },
    ];
    const events = await collectEvents([
      textDelta(firstChunk),
      {
        type: "text_delta",
        contentIndex: 2,
        delta: secondChunk,
        partial: { role: "assistant", content },
      },
      doneEvent(content),
    ]);

    expect(events.map((event) => event.type)).toEqual(["text_delta", "done"]);
    const expectedContent = [
      { type: "text", text: "" },
      { type: "thinking", thinking: "checking" },
      { type: "text", text: visibleText },
    ];
    expect(requireRecord(events[0], "text event")).toMatchObject({
      delta: visibleText,
      partial: { content: expectedContent },
    });
    expect(requireRecord(events[1], "done event").message).toMatchObject({
      content: expectedContent,
    });
    expect(JSON.stringify(events)).not.toContain(marker);
  });

  it("scrubs terminal XML split inside its function markers", async () => {
    const body = "\u00a0".repeat(128_001);
    const parts = ["<func", `tion=read>${body}</func`, "tion>"];
    const events = await collectEvents([doneEvent(parts.map(textBlock), "length")]);

    expect(requireRecord(events[0], "done event")).toMatchObject({
      type: "done",
      reason: "length",
      message: { role: "assistant", content: [], stopReason: "length" },
    });
    expect(JSON.stringify(events)).not.toContain("<func");
    expect(JSON.stringify(events)).not.toContain("tion>");
  });

  it("preserves the exact suffix after a compacted XML prefix and split terminator", async () => {
    const visibleText = "Visible after compacted XML";
    const chunks = ["<func", `tion=read>${" ".repeat(330_001)}</func`, `tion>\n${visibleText}`];
    const rawText = chunks.join("");
    const events = await collectTextDoneEvents(chunks, rawText);

    expect(rawText.length).toBeGreaterThan(320_000);
    expect(events.map((event) => event.type)).toEqual(["text_delta", "done"]);
    expect(events[0]).toMatchObject({ delta: visibleText });
    expect(messageOf(events[1]).content).toEqual([{ type: "text", text: visibleText }]);
    expect(JSON.stringify(events)).not.toContain("<func");
  });

  it("scrubs compacted error partials when an emoji crosses the safe prefix boundary", async () => {
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

    expect(events.map((event) => event.type)).toEqual(["error"]);
    const terminalError = requireRecord(events[0], "error event");
    expect(requireRecord(terminalError.partial, "error partial").content).toEqual([
      { type: "text", text: "" },
    ]);
    expect(requireRecord(terminalError.error, "error body").content).toEqual([]);
    expect(JSON.stringify(events)).not.toContain("[tool:read]");
  });

  it("scrubs mixed under-cap calls from multi-block errors without partials", async () => {
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

    expect(events.map((event) => event.type)).toEqual(["text_delta", "error"]);
    expect(requireRecord(events[0], "text event").delta).toBe(visibleText);
    expect(requireRecord(requireRecord(events[1], "error event").error, "error").content).toEqual([
      { type: "text", text: visibleText },
    ]);
    expect(JSON.stringify(events)).not.toContain("<function=read>");
  });

  it("preserves a visible suffix after a named over-cap parameter without a function close", async () => {
    const toolPrefix = ["[read]", "<parameter=path>", "x".repeat(256_001)].join("\n");
    const visibleSuffix = "Visible answer after the incomplete tool-looking block.";
    const tail = ["</parameter>", visibleSuffix].join("\n");
    const rawText = [toolPrefix, tail].join("\n");
    const events = await collectTextDoneEvents([toolPrefix, tail], rawText);

    expect(events.map((event) => event.type)).toEqual(["text_delta", "done"]);
    expect(requireRecord(events[0], "text event").delta).toBe(visibleSuffix);
    expect(messageOf(events[1]).content).toEqual([{ type: "text", text: visibleSuffix }]);
    expect(JSON.stringify(events)).not.toContain("[read]");
    expect(JSON.stringify(events)).not.toContain("</parameter>");
  });

  it("promotes split zero-argument XML function calls without leaking partials", async () => {
    const { source, stream } = createControlledPlainTextToolCallCompatStream();
    const iterator = (await stream)[Symbol.asyncIterator]();
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
          partial: {
            role: "assistant",
            content: [{ type: "text", text: streamedText }],
          },
        } as never);
      }
      source.push(doneEvent([textBlock(rawToolText)]) as never);

      const events = [
        await nextEvent(iterator, "zero-argument tool-call start"),
        await nextEvent(iterator, "zero-argument tool-call arguments"),
        await nextEvent(iterator, "zero-argument tool-call end"),
        await nextEvent(iterator, "zero-argument done event"),
      ];
      expect(events.map((event) => event.type)).toEqual([
        "toolcall_start",
        "toolcall_delta",
        "toolcall_end",
        "done",
      ]);
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

  it("does not buffer normal final prose until done", async () => {
    const { source, stream } = createControlledPlainTextToolCallCompatStream();
    const iterator = (await stream)[Symbol.asyncIterator]();

    try {
      source.push(completeStreamEvent({ type: "start", partial: { content: [] } }) as never);
      expect((await nextEvent(iterator, "start")).type).toBe("start");

      source.push({
        type: "text_delta",
        contentIndex: 0,
        delta: "final answer starts here",
      } as never);

      const event = await nextEvent(iterator, "normal final prose");
      expect(event).toMatchObject({ type: "text_delta", delta: "final answer starts here" });
    } finally {
      source.push({ type: "done", reason: "stop", message: {} } as never);
      source.end();
      await iterator.return?.();
    }
  });
});

describe("stripTrailingAnthropicAssistantPrefillWhenThinking", () => {
  it("removes trailing assistant text turns when Anthropic thinking is enabled", () => {
    const payload = {
      thinking: { type: "enabled", budget_tokens: 1024 },
      messages: [
        { role: "user", content: "Return JSON." },
        { role: "assistant", content: "{" },
        { role: "assistant", content: '"status"' },
      ],
    };

    expect(stripTrailingAnthropicAssistantPrefillWhenThinking(payload)).toBe(2);
    expect(payload.messages).toEqual([{ role: "user", content: "Return JSON." }]);
  });

  it("preserves assistant tool-use turns across Anthropic and OpenAI-shaped payloads", () => {
    const anthropicPayload = {
      thinking: { type: "adaptive" },
      messages: [
        { role: "user", content: "Read a file." },
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Read" }] },
      ],
    };
    const openAiPayload = {
      thinking: { type: "adaptive" },
      messages: [
        { role: "user", content: "Read a file." },
        { role: "assistant", content: [{ type: "toolCall", id: "call_1", name: "Read" }] },
      ],
    };
    const toolCallsPayload = {
      thinking: { type: "adaptive" },
      messages: [{ role: "assistant", tool_calls: [{ id: "call_1", name: "Read" }] }],
    };

    expect(stripTrailingAnthropicAssistantPrefillWhenThinking(anthropicPayload)).toBe(0);
    expect(stripTrailingAnthropicAssistantPrefillWhenThinking(openAiPayload)).toBe(0);
    expect(stripTrailingAnthropicAssistantPrefillWhenThinking(toolCallsPayload)).toBe(0);
  });

  it("keeps assistant prefill when Anthropic thinking is disabled", () => {
    const payload = {
      thinking: { type: "disabled" },
      messages: [
        { role: "user", content: "Return JSON." },
        { role: "assistant", content: "{" },
      ],
    };

    expect(stripTrailingAnthropicAssistantPrefillWhenThinking(payload)).toBe(0);
    expect(payload.messages).toHaveLength(2);
  });
});

describe("createAnthropicThinkingPrefillPayloadWrapper", () => {
  it("reports stripped assistant prefill count", () => {
    const payload = {
      thinking: { type: "enabled" },
      messages: [
        { role: "user", content: "Return JSON." },
        { role: "assistant", content: "{" },
      ],
    };
    let strippedCount = 0;
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      options?.onPayload?.(payload as never, _model as never);
      return {} as ReturnType<StreamFn>;
    };

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
});
