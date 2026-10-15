import { responsesServiceTierObserver } from "@openclaw/ai/internal/openai";
import { createAssistantMessageEventStream, type Model, type StreamFn } from "@openclaw/llm-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createOpenAIResponsesTransportStreamFn } from "../../../../packages/ai/src/transports/openai-responses-client.js";
import { createPreparedAccountCatalogAccess } from "../../../agents/prepared-model-runtime.catalog-auth.js";
import {
  registerAgentRunContext,
  resetAgentRunRegistryForTest,
} from "../../../infra/agent-run-registry.js";
import { createOpenAIServiceTierObservationWrapper } from "./openai-service-tier-observation.js";
import { createOpenAIFastModeWrapper } from "./openai.js";

const log = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
  isEnabled: () => false,
}));
// mock-isolation: Capture records without opening process-global file/console sinks.
vi.mock("../../../logging/subsystem.js", () => ({ createSubsystemLogger: () => log }));
const provider = vi.hoisted(() => ({
  tiers: [] as unknown[],
  rejectUltrafast: true,
  elapsedMs: 0,
}));
// Fake provider I/O; request assembly, recovery, parsing, and observations stay real.
vi.mock("openai", () => {
  class FakeOpenAI {
    responses = {
      create: (request: Record<string, unknown>) => {
        provider.tiers.push(request.service_tier);
        provider.elapsedMs += 100;
        const rejected = provider.rejectUltrafast && request.service_tier === "ultrafast";
        return {
          withResponse: async () => ({
            response: new Response(null, { status: 200 }),
            data: (async function* () {
              yield rejected
                ? {
                    type: "response.failed",
                    response: {
                      output: [],
                      error: { code: "invalid_prompt", message: "Invalid service_tier argument" },
                    },
                  }
                : {
                    type: "response.completed",
                    response: {
                      id: "resp_fixture",
                      status: "completed",
                      service_tier: request.service_tier,
                      output: [],
                      usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
                    },
                  };
            })(),
          }),
        };
      },
    };
  }
  return { default: FakeOpenAI, AzureOpenAI: FakeOpenAI };
});
beforeEach(() => {
  log.info.mockClear();
  provider.tiers.length = 0;
  provider.rejectUltrafast = true;
  provider.elapsedMs = 0;
  registerAgentRunContext("run-fixture", {});
});
afterEach(() => {
  resetAgentRunRegistryForTest();
  vi.useRealTimers();
});
const attribution = {
  runId: "run-fixture",
  sessionId: "session-fixture",
  accountRoute: "profile:openai:fixture",
};

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
    attribution,
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
  expect(log.info).toHaveBeenCalledTimes(2);
});

it("attributes a successful slower retry to the original rejected tier without altering overrides", async () => {
  const record = vi.fn(() => true);
  let captured: Parameters<StreamFn>[2];
  const base: StreamFn = (_model, _context, options) => {
    captured = options;
    return createAssistantMessageEventStream();
  };
  const wrapped = createOpenAIServiceTierObservationWrapper(base, record, attribution);
  const replacement = { service_tier: "ultrafast" };
  await wrapped(model, { messages: [] }, { onPayload: async () => replacement });
  responsesServiceTierObserver.reject(captured, "ultrafast");
  responsesServiceTierObserver.reject(captured, "priority");
  responsesServiceTierObserver.observe(captured, "default", "default", {
    id: "resp-fixture",
    model: "fixture-served",
    usage: {
      input_tokens: 12_000,
      input_tokens_details: { cached_tokens: 8_000, cache_write_tokens: 0 },
      output_tokens: 100,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 12_100,
    },
  });
  expect(record).toHaveBeenLastCalledWith(model, {
    requestedTier: "ultrafast",
    responseTier: "default",
  });
  expect(log.info).toHaveBeenLastCalledWith(expect.stringContaining("served as default"), {
    ...attribution,
    model: "fixture",
    provider: "openai",
    requestedTier: "ultrafast",
    wireRequestedTier: "default",
    responseTier: "default",
    requestId: undefined,
    responseId: "resp-fixture",
    responseModel: "fixture-served",
    inputTokens: 12_000,
    cachedTokens: 8_000,
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

async function providerTurn(
  runId = attribution.runId,
  replacement = false,
  record: Parameters<typeof createOpenAIServiceTierObservationWrapper>[1] = () => true,
) {
  // Worker inference recreates the wrapper for each model call in the same run.
  const stream = createOpenAIServiceTierObservationWrapper(
    createOpenAIFastModeWrapper(createOpenAIResponsesTransportStreamFn(), "ultrafast"),
    record,
    { ...attribution, runId },
  );
  const result = await stream(
    model,
    { messages: [] },
    {
      apiKey: "synthetic-key",
      ...(replacement
        ? {
            onPayload: async (payload: unknown) => ({
              ...Object(payload),
              service_tier: "ultrafast",
            }),
          }
        : {}),
    },
  );
  expect((await result.result()).stopReason).toBe("stop");
}

it("bounds persistent rejections across 30 model calls and probes after 20 cooldown calls", async () => {
  const record = vi.fn(() => true);
  for (let turn = 0; turn < 30; turn++) {
    await providerTurn(attribution.runId, true, record);
  }
  expect(record).toHaveBeenLastCalledWith(model, {
    requestedTier: "ultrafast",
    responseTier: "priority",
  });
  expect(provider.tiers).toEqual([
    "ultrafast",
    "priority",
    "ultrafast",
    "priority",
    ...Array(20).fill("priority"),
    "ultrafast",
    "priority",
    ...Array(7).fill("priority"),
  ]);
  // Fixed fake-provider latency: 30 useful requests plus only three rejected requests.
  expect(provider.elapsedMs).toBe(3_300);
});

it("probes after ten minutes, resets on success, and isolates a new run", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(1_000);
  await providerTurn();
  await providerTurn();
  vi.setSystemTime(600_999);
  await providerTurn();
  expect(provider.tiers.at(-1)).toBe("priority");
  vi.setSystemTime(601_000);
  provider.rejectUltrafast = false;
  await providerTurn();
  expect(provider.tiers.at(-1)).toBe("ultrafast");
  provider.rejectUltrafast = true;
  await providerTurn();
  await providerTurn();
  await providerTurn();
  expect(provider.tiers.slice(-5)).toEqual([
    "ultrafast",
    "priority",
    "ultrafast",
    "priority",
    "priority",
  ]);
  registerAgentRunContext("fresh-run", {});
  await providerTurn("fresh-run");
  expect(provider.tiers.slice(-2)).toEqual(["ultrafast", "priority"]);
});
