import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { createAssistantMessageEventStream, type Model } from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import { streamWithPayloadPatch } from "./stream-payload-utils.js";

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
    const sent = { ...SENSITIVE_PAYLOAD, extra: false };
    const underlying: StreamFn = (_model, _context, streamOptions) => {
      streamOptions?.onPayload?.(sent, _model);
      return createAssistantMessageEventStream();
    };
    invokePatch(underlying, {
      onPayload: () => {
        sent.extra = true;
      },
    });
    expect(sent.extra).toBe(true);
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
      onPayload: () => ({ ...SENSITIVE_PAYLOAD, extra: true }),
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
