import { expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { makeAgentAssistantMessage } from "../agents/test-helpers/agent-message-fixtures.js";
import { makeProviderModelFixture } from "../agents/test-helpers/provider-model-fixture.js";
import type { AssistantMessage, AssistantMessageEvent, ToolCall } from "../llm/types.js";
import { createAssistantMessageEventStream } from "../llm/utils/event-stream.js";
import { createNativeInferenceStreamGuard } from "./native-inference-stream.js";
import type { NativeRuntimeResolved } from "./native-runtime.js";
const secret = "synthetic-sensitive-value";
const secretPrefix = secret.slice(0, 12),
  secretSuffix = secret.slice(12);
const model = makeProviderModelFixture({
  provider: "test",
  id: "test",
  api: "openai-completions",
  baseUrl: "http://127.0.0.1:1",
});
function message(content: AssistantMessage["content"]): AssistantMessage {
  return makeAgentAssistantMessage({
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    timestamp: 1,
  });
}
function native(credential = secret): NativeRuntimeResolved {
  return {
    model,
    workspacePath: "/fixture",
    streamFn: () => {
      throw new Error("unused");
    },
    assertProtocolSafe: (value) => {
      const serialized = JSON.stringify(value);
      if (
        serialized.includes(credential) ||
        serialized.includes(JSON.stringify(credential).slice(1, -1))
      ) {
        throw new Error("credential reflection");
      }
    },
    hasCredentialPrefix: (value) => {
      if (typeof value !== "string") {
        return false;
      }
      const minSize = credential.length <= 16 ? 1 : 8;
      for (let size = credential.length - 1; size >= minSize && size > 0; size--) {
        if (value.endsWith(credential.slice(0, size))) {
          return true;
        }
      }
      return false;
    },
  };
}
async function collect(stream: ReturnType<ReturnType<typeof createNativeInferenceStreamGuard>>) {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return { events, message: await stream.result() };
}
function tool(
  args: ToolCall["arguments"] = {},
  overrides: Partial<Omit<ToolCall, "arguments">> = {},
): ToolCall {
  return { type: "toolCall", id: "call", name: "write", arguments: args, ...overrides };
}

function toolDelta(
  delta: string,
  partial: AssistantMessage,
  contentIndex = 0,
): AssistantMessageEvent {
  return { type: "toolcall_delta", contentIndex, delta, partial };
}

function toolEnd(
  call: ToolCall,
  contentIndex = 0,
  partial = message([call]),
): AssistantMessageEvent {
  return { type: "toolcall_end", contentIndex, toolCall: call, partial };
}

function finish(source: ReturnType<typeof createAssistantMessageEventStream>) {
  source.end();
  return collect(createNativeInferenceStreamGuard(native())(() => source));
}

function terminal(final: AssistantMessage): AssistantMessageEvent {
  return { type: "done", reason: "stop", message: final };
}

function scenario(events: AssistantMessageEvent[], final?: AssistantMessage, credential = secret) {
  const source = createAssistantMessageEventStream();
  events.forEach((event) => source.push(event));
  source.end(final);
  return collect(createNativeInferenceStreamGuard(native(credential))(() => source));
}

function expectBlocked(result: Awaited<ReturnType<typeof collect>>, ...fragments: string[]) {
  expect(result.message.stopReason).toBe("error");
  for (const fragment of fragments) {
    expect(JSON.stringify(result.events)).not.toContain(fragment);
  }
}

const generatedOwners: Array<[string, (value: string) => AssistantMessage]> = [
  ["tool id", (id) => message([tool({ path: "ordinary" }, { id, name: "read" })])],
  ["tool name", (name) => message([tool({ path: "ordinary" }, { name })])],
  ["nested argument value", (value) => message([tool({ nested: [value, "ordinary"] })])],
  ["nested argument key", (value) => message([tool({ nested: { [value]: "ordinary" } })])],
  ["tool thought signature", (thoughtSignature) => message([tool({}, { thoughtSignature })])],
  [
    "text signature",
    (value) => message([{ type: "text", text: "ordinary", textSignature: value }]),
  ],
  [
    "response id",
    (value) => ({ ...message([{ type: "text", text: "ordinary" }]), responseId: value }),
  ],
  [
    "provider replay data",
    (value) => ({
      ...message([{ type: "text", text: "ordinary" }]),
      providerReplay: {
        v: 1,
        type: "opaque",
        data: value,
        provider: "test",
        api: "openai-completions",
        model: "test",
      },
    }),
  ],
];
it.each(generatedOwners)(
  "withholds a credential prefix in %s before later completion",
  async (_field, makeMessage) => {
    const result = await scenario([
      { type: "start", partial: makeMessage(secret.slice(0, -1)) },
      terminal(makeMessage(secret)),
    ]);
    expectBlocked(result, secret.slice(0, -1));
  },
);
it("preserves legitimate prefix divergence in nested arguments", async () => {
  const makeMessage = generatedOwners[2]![1];
  const events: AssistantMessageEvent[] = [
    { type: "start", partial: makeMessage(secret.slice(0, 12)) },
    terminal(makeMessage(secret.slice(0, 12) + "ordinary")),
  ];
  expect(await scenario(events)).toEqual({
    events,
    message: makeMessage(secret.slice(0, 12) + "ordinary"),
  });
});
it("guards an authoritative result without a terminal event", async () => {
  const result = await scenario(
    [{ type: "start", partial: message([]) }],
    message([{ type: "text", text: secret }]),
  );
  expect(result.message.stopReason).toBe("error");
  expect(JSON.stringify(result)).not.toContain(secret);
});

it("guards a credential split across raw tool-argument deltas before parsed arguments exist", async () => {
  const partial = message([tool()]);
  const result = await scenario([
    { type: "start", partial },
    toolDelta('{"' + secret.slice(0, 12), partial),
    toolDelta(secret.slice(12) + '":', partial),
    terminal(message([])),
  ]);
  expectBlocked(result, secret.slice(0, 12), secret.slice(12));
});
it.each([
  ["argument key and value", (prefix: string, suffix: string) => tool({ [prefix]: suffix })],
  [
    "tool-call metadata",
    (prefix: string, suffix: string) => tool({ value: "ordinary" }, { id: prefix, name: suffix }),
  ],
] as const)("guards a credential split across %s", async (_field, makeCall) => {
  const prefix = secret.slice(0, 7),
    suffix = secret.slice(7);
  expectBlocked(
    await scenario([
      { type: "done", reason: "toolUse", message: message([makeCall(prefix, suffix)]) },
    ]),
    prefix,
    suffix,
  );
});
it("guards a decoded tool preview split across an argument key and value", async () => {
  const prefix = secret.slice(0, 7);
  const suffix = secret.slice(7);
  const partial = message([tool()]);
  const raw = JSON.stringify({ [prefix]: suffix });
  const result = await scenario([{ type: "start", partial }, toolDelta(raw, partial)], message([]));
  expect(result.message.stopReason).toBe("error");
  expect(result.events.filter((event) => event.type === "toolcall_delta")).toEqual([]);
});
it("checks the authoritative result before exposing the terminal event", async () => {
  const source = createAssistantMessageEventStream();
  source.push(terminal(message([{ type: "text", text: "ordinary" }])));
  source.end();
  const result = await collect(
    createNativeInferenceStreamGuard(native())(() => ({
      [Symbol.asyncIterator]: () => source[Symbol.asyncIterator](),
      result: async () => message([{ type: "text", text: secret }]),
    })),
  );
  expect(result.message.stopReason).toBe("error");
  expect(result.events.some((event) => event.type === "done")).toBe(false);
  expect(JSON.stringify(result)).not.toContain(secret);
});
it.each(["unicode", "escaped quote"] as const)(
  "withholds raw %s credential fragments before decoded terminal validation",
  async (encoding) => {
    const credential = encoding === "unicode" ? secret : 'synthetic-"sensitive-value';
    const encoded = JSON.stringify({ value: credential });
    const raw = encoding === "unicode" ? encoded.replace("synthetic", "\\u0073ynthetic") : encoded;
    expect(JSON.parse(raw)).toEqual({ value: credential });
    const split = raw.length - 3;
    const partial = message([tool()]);
    const result = await scenario(
      [
        { type: "start", partial },
        toolDelta(raw.slice(0, split), partial),
        toolDelta(raw.slice(split), partial),
        terminal(message([tool({ value: credential })])),
      ],
      undefined,
      credential,
    );
    expect(result.message.stopReason).toBe("error");
    expect(result.events.filter((event) => event.type === "toolcall_delta")).toEqual([]);
  },
);
it("does not replay a published tool argument when trailing whitespace arrives", async () => {
  const call = tool({ value: "ok" });
  const raw = JSON.stringify(call.arguments);
  const result = await scenario(
    [
      { type: "start", partial: message([]) },
      toolDelta(raw, message([call])),
      toolDelta(" ", message([call])),
      toolEnd(call),
    ],
    message([call]),
  );
  expect(result.events.filter((event) => event.type === "toolcall_delta")).toEqual([
    toolDelta(raw, message([call])),
  ]);
});
it("discards an undecodable raw preview when the tool call ends", async () => {
  const call = tool();
  const result = await scenario(
    [
      { type: "start", partial: message([call]) },
      toolDelta('{"value":"\\u0073ynthetic-sensitive-value', message([call])),
      toolEnd(call),
    ],
    message([call]),
  );
  expect(result.events.filter((event) => event.type === "toolcall_delta")).toEqual([]);
  expect(result.message).toEqual(message([call]));
});
it("coalesces cumulative held tool previews before applying the byte limit", async () => {
  const source = createAssistantMessageEventStream();
  const largeText = "ordinary".repeat(140_000);
  const partial = message([{ type: "text", text: largeText }, tool()]);
  source.push({ type: "start", partial });
  for (let index = 0; index < 25; index += 1) {
    source.push(toolDelta(index === 0 ? '{"value":"' : "x", partial, 1));
  }
  const final = message([{ type: "text", text: largeText }]);
  source.push(terminal(final));
  const result = await finish(source);
  expect(result.message).toEqual(final);
  expect(result.events.filter((event) => event.type === "toolcall_delta")).toEqual([]);
});
it.each([false, true])(
  "sanitizes credential-bearing provider startup failure (async=%s)",
  async (asyncFailure) => {
    const guard = createNativeInferenceStreamGuard(native());
    const result = await collect(
      guard(() => {
        if (asyncFailure) {
          return Promise.reject(new Error(secret));
        }
        throw new Error(secret);
      }),
    );
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result.message).toMatchObject({
      stopReason: "error",
      errorMessage: "Runtime-local inference failed its output boundary",
    });
  },
);
it.each(["id", "name"] as const)(
  "rejects a complete credential in tool-call %s metadata",
  async (field) => {
    const source = createAssistantMessageEventStream();
    const call = tool({}, { name: "read", [field]: secret });
    const final = message([call]);
    source.push(toolEnd(call, 0, final));
    source.push(terminal(final));
    const result = await finish(source);
    expect(result.message.stopReason).toBe("error");
    expect(JSON.stringify(result)).not.toContain(secret);
  },
);

it("holds incomplete prefixes across tool blocks before any generated tool can escape", async () => {
  const source = createAssistantMessageEventStream();
  const call = tool({ nested: [secretPrefix] }, { async: true });
  const partial = message([call]);
  source.push({ type: "start", partial: message([]) });
  source.push(toolEnd(call, 0, partial));
  const final = message([call, { type: "text", text: secretSuffix }]);
  source.push({ type: "text_start", contentIndex: 1, partial: final });
  source.push(terminal(final));
  const result = await finish(source);
  expectBlocked(result, secretPrefix, secretSuffix);
});
it("keeps text-prefix continuity across an intervening tool block", async () => {
  const source = createAssistantMessageEventStream();
  const call = tool({}, { name: "read" });
  source.push({ type: "start", partial: message([{ type: "text", text: secretPrefix }]) });
  const partial = message([{ type: "text", text: secretPrefix }, call]);
  source.push(toolEnd(call, 1, partial));
  const final = message([...partial.content, { type: "text", text: secretSuffix }]);
  source.push(terminal(final));
  const result = await finish(source);
  expectBlocked(result, secretPrefix, secretSuffix);
});
it("blocks a complete credential split across consecutive snapshot-free text deltas", async () => {
  const source = createAssistantMessageEventStream();
  source.push({ type: "start", partial: message([]) });
  source.push({ type: "text_delta", contentIndex: 0, delta: secret.slice(0, 12) });
  source.push({ type: "text_delta", contentIndex: 0, delta: secret.slice(12) });
  source.push(terminal(message([{ type: "text", text: secret }])));
  const result = await finish(source);
  expectBlocked(result, secret.slice(0, 12), secret.slice(12));
  expect(result.events.filter((event) => event.type === "text_delta")).toEqual([]);
});
it("streams ordinary divergence before completion, including snapshot-free deltas", async () => {
  const source = createAssistantMessageEventStream();
  const result = createNativeInferenceStreamGuard(native())(() => source);
  const events: AssistantMessageEvent[] = [];
  const expectedText = "synthetic-ordinary text";
  const earlyText = createDeferred();
  let streamedText = "";
  const drain = (async () => {
    for await (const event of result) {
      events.push(event);
      if (event.type === "text_delta") {
        streamedText += event.delta;
        if (streamedText.length >= expectedText.length) {
          earlyText.resolve();
        }
      }
    }
  })();
  source.push({ type: "start", partial: message([]) });
  source.push({
    type: "text_start",
    contentIndex: 0,
    partial: message([{ type: "text", text: "" }]),
  });
  source.push({ type: "text_delta", contentIndex: 0, delta: "synthetic-" });
  source.push({ type: "text_delta", contentIndex: 0, delta: "ordinary text" });
  try {
    // The event stream may coalesce unread adjacent deltas. Require all text
    // before sending a terminal event, regardless of provider packet boundaries.
    await Promise.race([earlyText.promise, drain]);
    expect(streamedText).toBe(expectedText);
    expect(events.some((event) => event.type === "done")).toBe(false);
    source.push(terminal(message([{ type: "text", text: expectedText }])));
    source.end();
    await drain;
    expect((await result.result()).stopReason).toBe("stop");
  } finally {
    source.end();
    await Promise.allSettled([drain]);
  }
});
it("withholds unresolved credential prefixes in terminal object arguments", async () => {
  const result = await scenario([], message([tool({ nested: { harmless: secretPrefix } })]));
  expectBlocked(result, secretPrefix);
});
it("does not retain a rejected credential prefix across provider responses", async () => {
  const guard = createNativeInferenceStreamGuard(native());
  const first = createAssistantMessageEventStream();
  first.push(terminal(message([{ type: "text", text: secretPrefix }])));
  first.end();
  const rejected = await collect(guard(() => first));
  expectBlocked(rejected, secretPrefix);
  const next = createAssistantMessageEventStream();
  next.push(terminal(message([{ type: "text", text: secret.slice(12) }])));
  next.end();
  const result = await collect(guard(() => next));
  expect(result.message.stopReason).toBe("stop");
});
