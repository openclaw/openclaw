import { responsesServiceTierObserver } from "@openclaw/ai/internal/openai";
import { createAssistantMessageEventStream, type Model, type StreamFn } from "@openclaw/llm-core";
import { expect, it, vi } from "vitest";
import { createPreparedAccountCatalogAccess } from "../../../agents/prepared-model-runtime.catalog-auth.js";
import { createOpenAIServiceTierObservationWrapper } from "./openai-service-tier-observation.js";
import { createOpenAIFastModeWrapper } from "./openai.js";

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

it("keeps requesting Ultrafast after a downgrade and clears it on the first honored response", async () => {
  const accountCatalog = createPreparedAccountCatalogAccess(() => true);
  const selectedCredential = {
    source: "profile" as const,
    profileId: "openai:fixture",
    identityKey: "profile:openai:fixture",
  };
  const record = accountCatalog.prepareServiceTierObserver({
    selectedCredential,
    credential: { type: "api_key", provider: "openai", key: "synthetic-key" },
  });
  const route = {
    modelId: model.id,
    runtimeId: "openclaw",
    api: model.api,
    baseUrl: model.baseUrl,
  };
  const read = () =>
    accountCatalog.readServiceTierObservation({
      ...route,
      identityKey: selectedCredential.identityKey,
    });
  const payloads: unknown[] = [];
  let responseTier = "priority";
  const base: StreamFn = async (_model, _context, options) => {
    const payload = {};
    await options?.onPayload?.(payload, model);
    payloads.push(payload);
    responsesServiceTierObserver.observe(options, "ultrafast", responseTier);
    return createAssistantMessageEventStream();
  };
  const previous = vi.fn();
  const options = {};
  responsesServiceTierObserver.set(options, previous);
  const wrapped = createOpenAIServiceTierObservationWrapper(
    createOpenAIFastModeWrapper(base, "ultrafast"),
    (_model, observation) => record({ ...route, ...observation }),
  );
  for (const tier of ["priority", "priority", "ultrafast"]) {
    responseTier = tier;
    await wrapped(model, { messages: [] }, options);
    expect(read()).toEqual(
      tier === "ultrafast" ? undefined : { requestedTier: "ultrafast", responseTier: "priority" },
    );
  }
  expect(payloads).toEqual(Array.from({ length: 3 }, () => ({ service_tier: "ultrafast" })));
  expect(previous).toHaveBeenCalledTimes(3);
});

it("attributes a successful slower retry to the original rejected tier without altering overrides", async () => {
  const record = vi.fn(() => true);
  let captured: Parameters<StreamFn>[2];
  const base: StreamFn = (_model, _context, options) => {
    captured = options;
    return createAssistantMessageEventStream();
  };
  const wrapped = createOpenAIServiceTierObservationWrapper(base, record);
  const replacement = { service_tier: "ultrafast" };
  await wrapped(model, { messages: [] }, { onPayload: async () => replacement });
  responsesServiceTierObserver.reject(captured, "ultrafast");
  responsesServiceTierObserver.reject(captured, "priority");
  responsesServiceTierObserver.observe(captured, "default", "default");
  expect(record).toHaveBeenLastCalledWith(model, {
    requestedTier: "ultrafast",
    responseTier: "default",
  });
  expect(await captured?.onPayload?.({}, model)).toBe(replacement);
  expect(replacement.service_tier).toBe("ultrafast");
  await wrapped(model, { messages: [] }, {});
  responsesServiceTierObserver.observe(captured, "ultrafast", "ultrafast");
  expect(record).toHaveBeenLastCalledWith(model, {
    requestedTier: "ultrafast",
    responseTier: "ultrafast",
  });
});
