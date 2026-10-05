import { responsesServiceTierObserver } from "@openclaw/ai/internal/openai";
import { createAssistantMessageEventStream, type Model, type StreamFn } from "@openclaw/llm-core";
import { expect, it } from "vitest";
import { createOpenAIServiceTierObservationWrapper } from "./openai-service-tier-observation.js";

const model: Model = {
  id: "fixture",
  name: "Fixture",
  provider: "openai",
  api: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
  input: ["text"],
  reasoning: false,
  contextWindow: 10000,
  maxTokens: 100,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

it("records rejected tiers without restoring earlier rejections or changing explicit payloads", async () => {
  const known = new Map<string, readonly string[]>();
  let options: Parameters<StreamFn>[2];
  let current = true;
  const base: StreamFn = (_model, _context, captured) => {
    options = captured;
    return createAssistantMessageEventStream();
  };
  const wrapped = createOpenAIServiceTierObservationWrapper(
    base,
    (target, tiers) => {
      if (!current) {
        return false;
      }
      known.set(target.id, tiers);
      return true;
    },
    (target) => (current ? known.get(target.id) : undefined),
  );
  await wrapped(model, { messages: [] }, {});
  expect(options).toBeDefined();
  responsesServiceTierObserver.reject(options!, "ultrafast");
  expect(known.get(model.id)).toEqual(["priority"]);
  const payload = { service_tier: "ultrafast" };
  await options?.onPayload?.(payload, model);
  expect(payload.service_tier).toBe("ultrafast");
  responsesServiceTierObserver.reject(options!, "priority");
  expect(known.get(model.id)).toEqual([]);
  const replacement = { service_tier: "ultrafast" };
  await wrapped(model, { messages: [] }, { onPayload: async () => replacement });
  await options?.onPayload?.({}, model);
  expect(replacement.service_tier).toBe("ultrafast");
  current = false;
  responsesServiceTierObserver.observe(options, "ultrafast", "default");
  expect(known.get(model.id)).toEqual([]);
});
