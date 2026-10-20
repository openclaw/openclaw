import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { createAssistantMessageEventStream, type Model } from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import { streamWithPayloadPatch, wrapProviderPayloadHook } from "./stream-payload-utils.js";

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

describe("provider payload hook composition", () => {
  it.each(["undefined", "null", "same", "replacement"] as const)(
    "settles %s without changing caller return or phase order",
    async (kind) => {
      for (const asynchronous of [false, true]) {
        const payload = { phase: "initial" };
        const replacement = { phase: "replacement" };
        const expected =
          kind === "undefined"
            ? undefined
            : kind === "null"
              ? null
              : kind === "same"
                ? payload
                : replacement;
        const phases: string[] = [];
        const hook = wrapProviderPayloadHook(
          (received, selectedModel) => {
            expect(received).toBe(payload);
            expect(selectedModel).toBe(model);
            phases.push(payload.phase);
            payload.phase = "caller";
            return asynchronous ? Promise.resolve(expected) : expected;
          },
          (received, result) => {
            expect(received).toBe(payload);
            phases.push(payload.phase);
            return result;
          },
          () => {
            payload.phase = "before";
          },
        );
        const result = hook(payload, model);
        expect(result instanceof Promise).toBe(asynchronous);
        expect(await result).toBe(expected);
        expect(phases).toEqual(["before", "caller"]);
      }
    },
  );
});
