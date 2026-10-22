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
  it.each(["in-place", "replacement", "async replacement"])("patches %s payloads", async (kind) => {
    const payload = { ...SENSITIVE_PAYLOAD, extra: false };
    let result: unknown;
    invokePatch(
      (_model, _context, options) => {
        result = options?.onPayload?.(payload, _model);
        return createAssistantMessageEventStream();
      },
      {
        onPayload: () => {
          if (kind === "in-place") {
            payload.extra = true;
          }
          const replacement = { ...SENSITIVE_PAYLOAD, extra: true };
          return kind === "in-place"
            ? undefined
            : kind === "replacement"
              ? replacement
              : Promise.resolve(replacement);
        },
      },
    );
    expect((await result) ?? payload).toEqual({ messages: [], extra: true });
  });
});

describe("provider payload hook composition", () => {
  it.each(["undefined", "null", "same", "replacement"] as const)(
    "settles %s without changing caller return or phase order",
    async (kind) => {
      for (const asynchronous of [false, true]) {
        const payload = { phase: "initial" };
        const replacement = { phase: "replacement" };
        const expected = { undefined, null: null, same: payload, replacement }[kind];
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
