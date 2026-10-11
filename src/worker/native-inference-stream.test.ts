import { describe, expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { AssistantMessage, AssistantMessageEvent, Model } from "../llm/types.js";
import { createAssistantMessageEventStream } from "../llm/utils/event-stream.js";
import { createNativeInferenceStreamGuard } from "./native-inference-stream.js";
import type { NativeRuntimeResolved } from "./native-runtime.js";
const secret = "synthetic-sensitive-value";
const model: Model = {
  provider: "test",
  id: "test",
  name: "test",
  api: "openai-completions",
  baseUrl: "http://127.0.0.1:1",
  reasoning: false,
  input: ["text"],
  contextWindow: 8192,
  maxTokens: 1024,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
function message(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    stopReason: "stop",
    timestamp: 1,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
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
describe("worker native inference output owner", () => {
  const generatedOwners: Array<[string, (value: string) => AssistantMessage]> = [
    [
      "tool id",
      (value) =>
        message([{ type: "toolCall", id: value, name: "read", arguments: { path: "ordinary" } }]),
    ],
    [
      "tool name",
      (value) =>
        message([{ type: "toolCall", id: "call", name: value, arguments: { path: "ordinary" } }]),
    ],
    [
      "nested argument value",
      (value) =>
        message([
          {
            type: "toolCall",
            id: "call",
            name: "write",
            arguments: { nested: [value, "ordinary"] },
          },
        ]),
    ],
    [
      "nested argument key",
      (value) =>
        message([
          {
            type: "toolCall",
            id: "call",
            name: "write",
            arguments: { nested: { [value]: "ordinary" } },
          },
        ]),
    ],
    [
      "tool thought signature",
      (value) =>
        message([
          { type: "toolCall", id: "call", name: "read", arguments: {}, thoughtSignature: value },
        ]),
    ],
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
      const prefix = secret.slice(0, -1);
      const source = createAssistantMessageEventStream();
      source.push({ type: "start", partial: makeMessage(prefix) });
      source.push({ type: "done", reason: "stop", message: makeMessage(secret) });
      source.end();
      const result = await collect(createNativeInferenceStreamGuard(native())(() => source));
      expect(result.message.stopReason).toBe("error");
      expect(JSON.stringify(result.events)).not.toContain(prefix);
    },
  );
  it.each(generatedOwners)(
    "preserves legitimate prefix divergence in %s",
    async (_field, makeMessage) => {
      const source = createAssistantMessageEventStream();
      const events: AssistantMessageEvent[] = [
        { type: "start", partial: makeMessage(secret.slice(0, 12)) },
        { type: "done", reason: "stop", message: makeMessage(secret.slice(0, 12) + "ordinary") },
      ];
      for (const event of events) {
        source.push(event);
      }
      source.end();
      const result = await collect(createNativeInferenceStreamGuard(native())(() => source));
      expect(result.events).toEqual(events);
      expect(result.message).toEqual(makeMessage(secret.slice(0, 12) + "ordinary"));
    },
  );
  it.each(["ordinary", secret])(
    "guards an authoritative result without a terminal event (%s)",
    async (value) => {
      const source = createAssistantMessageEventStream();
      const final = message([{ type: "text", text: value }]);
      source.push({ type: "start", partial: message([]) });
      source.end(final);
      const result = await collect(createNativeInferenceStreamGuard(native())(() => source));
      if (value === secret) {
        expect(result.message.stopReason).toBe("error");
        expect(JSON.stringify(result)).not.toContain(secret);
      } else {
        expect(result.message).toEqual(final);
        expect(result.events.at(-1)).toEqual({ type: "done", reason: "stop", message: final });
      }
    },
  );

  it("guards a credential split across raw tool-argument deltas before parsed arguments exist", async () => {
    const source = createAssistantMessageEventStream();
    const partial = message([{ type: "toolCall", id: "call", name: "write", arguments: {} }]);
    source.push({ type: "start", partial });
    source.push({
      type: "toolcall_delta",
      contentIndex: 0,
      delta: '{"' + secret.slice(0, 12),
      partial,
    });
    source.push({
      type: "toolcall_delta",
      contentIndex: 0,
      delta: secret.slice(12) + '":',
      partial,
    });
    source.push({ type: "done", reason: "stop", message: message([]) });
    source.end();
    const result = await collect(createNativeInferenceStreamGuard(native())(() => source));
    expect(result.message.stopReason).toBe("error");
    expect(JSON.stringify(result.events)).not.toContain(secret.slice(0, 12));
    expect(JSON.stringify(result.events)).not.toContain(secret.slice(12));
  });
  it("guards a credential split across an argument key and value", async () => {
    const source = createAssistantMessageEventStream();
    const prefix = secret.slice(0, 7);
    const suffix = secret.slice(7);
    const final = message([
      { type: "toolCall", id: "call", name: "write", arguments: { [prefix]: suffix } },
    ]);
    source.push({ type: "done", reason: "toolUse", message: final });
    source.end();
    const result = await collect(createNativeInferenceStreamGuard(native())(() => source));
    expect(result.message.stopReason).toBe("error");
    expect(JSON.stringify(result.events)).not.toContain(prefix);
    expect(JSON.stringify(result.events)).not.toContain(suffix);
  });
  it("guards a decoded tool preview split across an argument key and value", async () => {
    const source = createAssistantMessageEventStream();
    const prefix = secret.slice(0, 7);
    const suffix = secret.slice(7);
    const partial = message([{ type: "toolCall", id: "call", name: "write", arguments: {} }]);
    const raw = JSON.stringify({ [prefix]: suffix });
    source.push({ type: "start", partial });
    source.push({ type: "toolcall_delta", contentIndex: 0, delta: raw, partial });
    source.end(message([]));
    const result = await collect(createNativeInferenceStreamGuard(native())(() => source));
    expect(result.message.stopReason).toBe("error");
    expect(result.events.filter((event) => event.type === "toolcall_delta")).toEqual([]);
  });
  it("guards a credential split across tool-call metadata fields", async () => {
    const source = createAssistantMessageEventStream();
    const prefix = secret.slice(0, 7);
    const suffix = secret.slice(7);
    const final = message([
      { type: "toolCall", id: prefix, name: suffix, arguments: { value: "ordinary" } },
    ]);
    source.push({ type: "done", reason: "toolUse", message: final });
    source.end();
    const result = await collect(createNativeInferenceStreamGuard(native())(() => source));
    expect(result.message.stopReason).toBe("error");
    expect(JSON.stringify(result.events)).not.toContain(prefix);
    expect(JSON.stringify(result.events)).not.toContain(suffix);
  });
  it("checks the authoritative result before exposing the terminal event", async () => {
    const source = createAssistantMessageEventStream();
    source.push({
      type: "done",
      reason: "stop",
      message: message([{ type: "text", text: "ordinary" }]),
    });
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
      const raw =
        encoding === "unicode" ? encoded.replace("synthetic", "\\u0073ynthetic") : encoded;
      expect(JSON.parse(raw)).toEqual({ value: credential });
      const split = raw.length - 3;
      const source = createAssistantMessageEventStream();
      const partial = message([{ type: "toolCall", id: "call", name: "write", arguments: {} }]);
      source.push({ type: "start", partial });
      source.push({ type: "toolcall_delta", contentIndex: 0, delta: raw.slice(0, split), partial });
      source.push({ type: "toolcall_delta", contentIndex: 0, delta: raw.slice(split), partial });
      source.push({
        type: "done",
        reason: "stop",
        message: message([
          { type: "toolCall", id: "call", name: "write", arguments: { value: credential } },
        ]),
      });
      source.end();
      const result = await collect(
        createNativeInferenceStreamGuard(native(credential))(() => source),
      );
      expect(result.message.stopReason).toBe("error");
      expect(result.events.filter((event) => event.type === "toolcall_delta")).toEqual([]);
    },
  );
  it("preserves legitimate escaped tool arguments after complete JSON validation", async () => {
    const source = createAssistantMessageEventStream();
    const call = {
      type: "toolCall" as const,
      id: "call",
      name: "write",
      arguments: { value: 'ordinary "quoted" text' },
    };
    const raw = JSON.stringify(call.arguments);
    const events: AssistantMessageEvent[] = [
      { type: "start", partial: message([]) },
      { type: "toolcall_delta", contentIndex: 0, delta: raw.slice(0, 12), partial: message([]) },
      { type: "toolcall_delta", contentIndex: 0, delta: raw.slice(12), partial: message([call]) },
      { type: "done", reason: "stop", message: message([call]) },
    ];
    for (const event of events) {
      source.push(event);
    }
    source.end();
    const result = await collect(createNativeInferenceStreamGuard(native())(() => source));
    expect(result.events.filter((event) => event.type === "toolcall_delta")).toEqual([
      {
        type: "toolcall_delta",
        contentIndex: 0,
        delta: raw,
        partial: message([call]),
      },
    ]);
    expect(result.message).toEqual(message([call]));
  });
  it("does not replay a published tool argument when trailing whitespace arrives", async () => {
    const source = createAssistantMessageEventStream();
    const call = {
      type: "toolCall" as const,
      id: "call",
      name: "write",
      arguments: { value: "ok" },
    };
    const raw = JSON.stringify(call.arguments);
    source.push({ type: "start", partial: message([]) });
    source.push({ type: "toolcall_delta", contentIndex: 0, delta: raw, partial: message([call]) });
    source.push({ type: "toolcall_delta", contentIndex: 0, delta: " ", partial: message([call]) });
    source.push({
      type: "toolcall_end",
      contentIndex: 0,
      toolCall: call,
      partial: message([call]),
    });
    source.end(message([call]));
    const result = await collect(createNativeInferenceStreamGuard(native())(() => source));
    expect(result.events.filter((event) => event.type === "toolcall_delta")).toEqual([
      { type: "toolcall_delta", contentIndex: 0, delta: raw, partial: message([call]) },
    ]);
  });
  it("discards an undecodable raw preview when the tool call ends", async () => {
    const source = createAssistantMessageEventStream();
    const call = { type: "toolCall" as const, id: "call", name: "write", arguments: {} };
    source.push({ type: "start", partial: message([call]) });
    source.push({
      type: "toolcall_delta",
      contentIndex: 0,
      delta: '{"value":"\\u0073ynthetic-sensitive-value',
      partial: message([call]),
    });
    source.push({
      type: "toolcall_end",
      contentIndex: 0,
      toolCall: call,
      partial: message([call]),
    });
    source.end(message([call]));
    const result = await collect(createNativeInferenceStreamGuard(native())(() => source));
    expect(result.events.filter((event) => event.type === "toolcall_delta")).toEqual([]);
    expect(result.message).toEqual(message([call]));
  });
  it("preserves the authoritative final message without releasing uncertified incomplete JSON previews", async () => {
    const source = createAssistantMessageEventStream();
    const final = message([{ type: "text", text: "ordinary final output" }]);
    source.push({ type: "start", partial: message([]) });
    source.push({
      type: "toolcall_delta",
      contentIndex: 0,
      delta: '{"value":"\\u0073ynthetic-',
      partial: message([]),
    });
    source.end(final);
    const result = await collect(createNativeInferenceStreamGuard(native())(() => source));
    expect(result.message).toEqual(final);
    expect(result.events.filter((event) => event.type === "toolcall_delta")).toEqual([]);
  });
  it("coalesces cumulative held tool previews before applying the byte limit", async () => {
    const source = createAssistantMessageEventStream();
    const largeText = "ordinary".repeat(140_000);
    const partial = message([
      { type: "text", text: largeText },
      { type: "toolCall", id: "call", name: "write", arguments: {} },
    ]);
    source.push({ type: "start", partial });
    for (let index = 0; index < 25; index += 1) {
      source.push({
        type: "toolcall_delta",
        contentIndex: 1,
        delta: index === 0 ? '{"value":"' : "x",
        partial,
      });
    }
    const final = message([{ type: "text", text: largeText }]);
    source.push({ type: "done", reason: "stop", message: final });
    source.end();
    const result = await collect(createNativeInferenceStreamGuard(native())(() => source));
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
      const call = {
        type: "toolCall" as const,
        id: "call",
        name: "read",
        arguments: {},
        [field]: secret,
      };
      const final = message([call]);
      source.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: final });
      source.push({ type: "done", reason: "stop", message: final });
      source.end();
      const result = await collect(createNativeInferenceStreamGuard(native())(() => source));
      expect(result.message.stopReason).toBe("error");
      expect(JSON.stringify(result)).not.toContain(secret);
    },
  );
  it("holds incomplete prefixes across tool blocks before any generated tool can escape", async () => {
    const source = createAssistantMessageEventStream();
    const prefix = secret.slice(0, 12),
      suffix = secret.slice(12);
    const call = {
      type: "toolCall" as const,
      id: "call",
      name: "write",
      arguments: { nested: [prefix] },
      async: true as const,
    };
    const partial = message([call]);
    source.push({ type: "start", partial: message([]) });
    source.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial });
    const final = message([call, { type: "text", text: suffix }]);
    source.push({ type: "text_start", contentIndex: 1, partial: final });
    source.push({ type: "done", reason: "stop", message: final });
    source.end();
    const result = await collect(createNativeInferenceStreamGuard(native())(() => source));
    expect(result.message.stopReason).toBe("error");
    expect(JSON.stringify(result.events)).not.toContain(prefix);
    expect(JSON.stringify(result.events)).not.toContain(suffix);
  });
  it("keeps text-prefix continuity across an intervening tool block", async () => {
    const source = createAssistantMessageEventStream();
    const prefix = secret.slice(0, 12);
    const suffix = secret.slice(12);
    const call = { type: "toolCall" as const, id: "call", name: "read", arguments: {} };
    source.push({ type: "start", partial: message([{ type: "text", text: prefix }]) });
    source.push({
      type: "toolcall_end",
      contentIndex: 1,
      toolCall: call,
      partial: message([{ type: "text", text: prefix }, call]),
    });
    const final = message([{ type: "text", text: prefix }, call, { type: "text", text: suffix }]);
    source.push({ type: "done", reason: "stop", message: final });
    source.end();
    const result = await collect(createNativeInferenceStreamGuard(native())(() => source));
    expect(result.message.stopReason).toBe("error");
    expect(JSON.stringify(result.events)).not.toContain(prefix);
    expect(JSON.stringify(result.events)).not.toContain(suffix);
  });
  it("blocks a complete credential split across consecutive snapshot-free text deltas", async () => {
    const source = createAssistantMessageEventStream();
    source.push({ type: "start", partial: message([]) });
    source.push({ type: "text_delta", contentIndex: 0, delta: secret.slice(0, 12) });
    source.push({ type: "text_delta", contentIndex: 0, delta: secret.slice(12) });
    source.push({
      type: "done",
      reason: "stop",
      message: message([{ type: "text", text: secret }]),
    });
    source.end();
    const result = await collect(createNativeInferenceStreamGuard(native())(() => source));
    expect(result.message.stopReason).toBe("error");
    expect(result.events.filter((event) => event.type === "text_delta")).toEqual([]);
    expect(JSON.stringify(result.events)).not.toContain(secret.slice(0, 12));
    expect(JSON.stringify(result.events)).not.toContain(secret.slice(12));
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
      source.push({
        type: "done",
        reason: "stop",
        message: message([{ type: "text", text: expectedText }]),
      });
      source.end();
      await drain;
      expect((await result.result()).stopReason).toBe("stop");
    } finally {
      source.end();
      await Promise.allSettled([drain]);
    }
  });
  it("withholds unresolved credential prefixes in terminal object arguments", async () => {
    const guard = createNativeInferenceStreamGuard(native());
    const first = createAssistantMessageEventStream();
    const prefix = secret.slice(0, 12);
    first.end(
      message([
        {
          type: "toolCall",
          id: "call",
          name: "write",
          arguments: { nested: { harmless: prefix } },
        },
      ]),
    );
    const result = await collect(guard(() => first));
    expect(result.message.stopReason).toBe("error");
    expect(JSON.stringify(result.events)).not.toContain(prefix);
  });
  it("does not retain a rejected credential prefix across provider responses", async () => {
    const guard = createNativeInferenceStreamGuard(native());
    const first = createAssistantMessageEventStream();
    const prefix = secret.slice(0, 12);
    first.push({
      type: "done",
      reason: "stop",
      message: message([{ type: "text", text: prefix }]),
    });
    first.end();
    const rejected = await collect(guard(() => first));
    expect(rejected.message.stopReason).toBe("error");
    expect(JSON.stringify(rejected.events)).not.toContain(prefix);
    const next = createAssistantMessageEventStream();
    next.push({
      type: "done",
      reason: "stop",
      message: message([{ type: "text", text: secret.slice(12) }]),
    });
    next.end();
    const result = await collect(guard(() => next));
    expect(result.message.stopReason).toBe("stop");
  });
});
