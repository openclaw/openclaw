import { responsesServiceTierObserver } from "@openclaw/ai/internal/openai";
import { createAssistantMessageEventStream, type StreamFn } from "@openclaw/llm-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createOpenAIResponsesTransportStreamFn } from "../../../../packages/ai/src/transports/openai-responses-client.js";
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
        return {
          withResponse: async () => ({
            response: new Response(null, { status: 200 }),
            data: (async function* () {
              yield {
                type: rejected ? "response.failed" : "response.completed",
                response: {
                  output: [],
                  ...(rejected
                    ? {
                        error: { code: "invalid_prompt", message: "Invalid service_tier argument" },
                      }
                    : {
                        id: "resp_fixture",
                        status: "completed",
                        service_tier: request.service_tier,
                        usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
                      }),
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
const observation = (responseTier: string) => ({ requestedTier: "ultrafast", responseTier });

const model = makeProviderModelFixture<"openai-responses">({
  id: "fixture",
  provider: "openai",
  api: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
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
  const previous = vi.fn();
  const options = { onPayload: async () => replacement };
  responsesServiceTierObserver.set(options, previous);
  await wrapped(model, { messages: [] }, options);
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
  expect(record).toHaveBeenLastCalledWith(model, observation("default"));
  expect(log.info.mock.lastCall?.[1]).toMatchObject({
    ...attribution,
    requestedTier: "ultrafast",
    wireRequestedTier: "default",
    responseTier: "default",
    responseId: "resp-fixture",
    responseModel: "fixture-served",
    inputTokens: 12_000,
    cachedTokens: 8_000,
  });
  expect(await captured?.onPayload?.({}, model)).toBe(replacement);
  expect(replacement.service_tier).toBe("ultrafast");
  record.mockReturnValueOnce(false);
  responsesServiceTierObserver.observe(captured, "default", "default");
  expect(log.debug).toHaveBeenCalledTimes(1);
  expect(log.info).toHaveBeenCalledTimes(3);
  expect(previous).toHaveBeenCalledTimes(4);
  await wrapped(model, { messages: [] }, {});
  responsesServiceTierObserver.observe(captured, "ultrafast", "ultrafast");
  expect(record).toHaveBeenLastCalledWith(model, observation("ultrafast"));
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
  expect(record).toHaveBeenLastCalledWith(model, observation("priority"));
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
