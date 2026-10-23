import { responsesServiceTierObserver } from "@openclaw/ai/internal/openai";
import { createAssistantMessageEventStream, type StreamFn } from "@openclaw/llm-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createOpenAIResponsesTransportStreamFn } from "../../../../packages/ai/src/transports/openai-responses-client.js";
import { createPreparedAccountCatalogAccess } from "../../../agents/prepared-model-runtime.catalog-auth.js";
import { makeProviderModelFixture } from "../../../agents/test-helpers/provider-model-fixture.js";
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
}));
// Fake provider I/O; request assembly, recovery, parsing, and observations stay real.
vi.mock("openai", () => {
  class FakeOpenAI {
    responses = {
      create: (request: Record<string, unknown>) => {
        provider.tiers.push(request.service_tier);
        const rejected = provider.rejectUltrafast && request.service_tier === "ultrafast";
        const event = rejected
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
        return {
          withResponse: async () => ({
            response: new Response(null, { status: 200 }),
            data: (async function* () {
              yield event;
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
  log.debug.mockClear();
  provider.tiers.length = 0;
  provider.rejectUltrafast = true;
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
const retry = ["ultrafast", "priority"];
function expectedObservation(responseTier: string) {
  return { requestedTier: "ultrafast", responseTier };
}

const model = makeProviderModelFixture<"openai-responses">({
  id: "fixture",
  name: "Fixture",
  provider: "openai",
  api: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
  contextWindow: 10000,
  maxTokens: 100,
});

it("keeps requesting Ultrafast after a downgrade and clears it on the first honored response", async () => {
  const accountCatalog = createPreparedAccountCatalogAccess(() => true);
  const record = accountCatalog.prepareServiceTierObserver({
    selectedCredential: {
      source: "profile",
      profileId: "openai:fixture",
      identityKey: attribution.accountRoute,
    },
    credential: { type: "api_key", provider: "openai", key: "synthetic-key" },
  });
  const route = {
    modelId: model.id,
    runtimeId: "openclaw",
    api: model.api,
    baseUrl: model.baseUrl,
  };
  const read = () =>
    accountCatalog.readServiceTierObservations({
      ...route,
      identityKey: attribution.accountRoute,
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
    expect(read()).toEqual(tier === "ultrafast" ? [] : [expectedObservation("priority")]);
  }
  expect(payloads).toEqual(Array.from({ length: 3 }, () => ({ service_tier: "ultrafast" })));
  expect(previous).toHaveBeenCalledTimes(3);
  expect(log.info).toHaveBeenCalledTimes(1);
  expect(log.debug).toHaveBeenCalledTimes(1);
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
  expect(record).toHaveBeenLastCalledWith(model, expectedObservation("default"));
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
  expect(record).toHaveBeenLastCalledWith(model, expectedObservation("ultrafast"));
});

async function providerTurn(
  runId = attribution.runId,
  options: Parameters<StreamFn>[2] = {},
  record: Parameters<typeof createOpenAIServiceTierObservationWrapper>[1] = () => true,
) {
  // Worker inference recreates the wrapper for each model call in the same run.
  const stream = createOpenAIServiceTierObservationWrapper(
    createOpenAIFastModeWrapper(createOpenAIResponsesTransportStreamFn(), "ultrafast"),
    record,
    { ...attribution, runId },
  );
  const result = await stream(model, { messages: [] }, { apiKey: "synthetic-key", ...options });
  expect((await result.result()).stopReason).toBe("stop");
}

it("bounds persistent rejections across 30 model calls and probes after 20 cooldown calls", async () => {
  const record = vi.fn(() => true);
  const options = {
    onPayload: async (payload: unknown) => ({ ...Object(payload), service_tier: "ultrafast" }),
  };
  for (let turn = 0; turn < 30; turn++) {
    await providerTurn(attribution.runId, options, record);
  }
  expect(record).toHaveBeenLastCalledWith(model, expectedObservation("priority"));
  expect(provider.tiers).toEqual([
    ...retry,
    ...retry,
    ...Array(20).fill("priority"),
    ...retry,
    ...Array(7).fill("priority"),
  ]);
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
  expect(provider.tiers.slice(-5)).toEqual([...retry, ...retry, "priority"]);
  registerAgentRunContext("fresh-run", {});
  await providerTurn("fresh-run");
  expect(provider.tiers.slice(-2)).toEqual(retry);
});
