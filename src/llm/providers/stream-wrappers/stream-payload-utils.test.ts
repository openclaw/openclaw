import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { createAssistantMessageEventStream, type Model } from "openclaw/plugin-sdk/llm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { streamSimpleOpenAICompletions } from "../../../../packages/ai/src/providers/openai-completions.js";
import { streamWithPayloadPatch } from "./stream-payload-utils.js";

const openaiCompletionsModel = {
  id: "gpt-5.5",
  name: "GPT-5.5",
  api: "openai-completions",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4096,
} as Model<"openai-completions">;

const openaiCompletionsContext = {
  messages: [{ role: "user", content: "hi", timestamp: 1 }],
} as Parameters<StreamFn>[1];

const sseBody = [
  `data: ${JSON.stringify({
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    created: 1,
    model: "gpt-5.5",
    choices: [{ index: 0, delta: { role: "assistant", content: "hi" }, finish_reason: null }],
  })}\n\n`,
  `data: ${JSON.stringify({
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    created: 1,
    model: "gpt-5.5",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  })}\n\n`,
  "data: [DONE]\n\n",
].join("");

function stubOpenAICompletionsFetch(requestBodies: string[]): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
      if (init?.body instanceof Uint8Array) {
        requestBodies.push(new TextDecoder().decode(init.body));
      }
      return new Response(sseBody, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const model = {
  api: "openai-responses",
  provider: "synthetic",
  id: "test-model",
} as Model<"openai-responses">;

const SENSITIVE_PAYLOAD = { store: true, prompt_cache_key: "cached", messages: [] };

function invokePatch(underlying: StreamFn, options: Parameters<StreamFn>[2] = {}) {
  void streamWithPayloadPatch(underlying, model, { messages: [] }, options, (payload) => {
    delete payload.store;
    delete payload.prompt_cache_key;
  });
}

describe("streamWithPayloadPatch", () => {
  it("mutates the provider payload in place when the wrapped hook keeps it", () => {
    const sent = { ...SENSITIVE_PAYLOAD };
    const underlying: StreamFn = (_model, _context, streamOptions) => {
      streamOptions?.onPayload?.(sent, _model);
      return createAssistantMessageEventStream();
    };
    invokePatch(underlying);
    expect(sent.store).toBeUndefined();
    expect(sent.prompt_cache_key).toBeUndefined();
  });

  it("keeps the patch applied when the wrapped hook returns a replacement payload", () => {
    const sent: unknown[] = [];
    const underlying: StreamFn = (_model, _context, streamOptions) => {
      sent.push(streamOptions?.onPayload?.({ ...SENSITIVE_PAYLOAD }, _model));
      return createAssistantMessageEventStream();
    };
    invokePatch(underlying, {
      onPayload: () => {
        // A hook may rebuild the request body independently instead of mutating
        // the received payload in place.
        return { ...SENSITIVE_PAYLOAD, extra: true };
      },
    });
    const outgoing = sent[0] as Record<string, unknown>;
    expect(outgoing.extra).toBe(true);
    expect(outgoing.store).toBeUndefined();
    expect(outgoing.prompt_cache_key).toBeUndefined();
  });

  it("keeps the patch applied when the wrapped hook asynchronously returns a replacement", async () => {
    const sent: unknown[] = [];
    const underlying: StreamFn = (_model, _context, streamOptions) => {
      sent.push(streamOptions?.onPayload?.({ ...SENSITIVE_PAYLOAD }, _model));
      return createAssistantMessageEventStream();
    };
    invokePatch(underlying, {
      onPayload: () => Promise.resolve({ ...SENSITIVE_PAYLOAD, extra: true }),
    });
    const outgoing = (await sent[0]) as Record<string, unknown>;
    expect(outgoing.extra).toBe(true);
    expect(outgoing.store).toBeUndefined();
    expect(outgoing.prompt_cache_key).toBeUndefined();
  });
});

describe("streamWithPayloadPatch through the real OpenAI completions transport", () => {
  it("sends a synchronously replaced request body with the patch applied", async () => {
    const requestBodies: string[] = [];
    stubOpenAICompletionsFetch(requestBodies);
    const result = streamWithPayloadPatch(
      streamSimpleOpenAICompletions as unknown as StreamFn,
      openaiCompletionsModel,
      openaiCompletionsContext,
      {
        apiKey: "sk-test",
        onPayload: (payload) => ({
          // Rebuild the body independently of the received payload while
          // re-adding the sensitive fields the wrapper policy must strip.
          ...(payload as Record<string, unknown>),
          store: true,
          prompt_cache_key: "cached",
        }),
      },
      (payload) => {
        delete payload.store;
        delete payload.prompt_cache_key;
      },
    );
    const stream = result as { result: () => Promise<unknown> };
    const message = (await stream.result()) as { stopReason?: string };
    expect(message.stopReason).toBe("stop");
    expect(requestBodies).toHaveLength(1);
    const sent = JSON.parse(requestBodies[0]!) as Record<string, unknown>;
    expect(sent.store).toBeUndefined();
    expect(sent.prompt_cache_key).toBeUndefined();
  });

  it("sends an asynchronously replaced request body with the patch applied", async () => {
    const requestBodies: string[] = [];
    stubOpenAICompletionsFetch(requestBodies);
    const result = streamWithPayloadPatch(
      streamSimpleOpenAICompletions as unknown as StreamFn,
      openaiCompletionsModel,
      openaiCompletionsContext,
      {
        apiKey: "sk-test",
        onPayload: (payload) =>
          Promise.resolve({
            ...(payload as Record<string, unknown>),
            store: true,
            prompt_cache_key: "cached",
          }),
      },
      (payload) => {
        delete payload.store;
        delete payload.prompt_cache_key;
      },
    );
    const stream = result as { result: () => Promise<unknown> };
    const message = (await stream.result()) as { stopReason?: string };
    expect(message.stopReason).toBe("stop");
    expect(requestBodies).toHaveLength(1);
    const sent = JSON.parse(requestBodies[0]!) as Record<string, unknown>;
    expect(sent.store).toBeUndefined();
    expect(sent.prompt_cache_key).toBeUndefined();
  });
});
