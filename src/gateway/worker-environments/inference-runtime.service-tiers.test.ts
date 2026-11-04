import assert from "node:assert/strict";
import { expect, it, vi } from "vitest";
import * as extraParamsRuntime from "../../agents/embedded-agent-runner/extra-params.js";
import { createOpenAIResponsesTransportStreamFn } from "../../agents/openai-transport-stream.js";
import { createPreparedAccountCatalogAccess } from "../../agents/prepared-model-runtime.catalog-auth.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  createOpenAIFastModeWrapper,
  resolveOpenAIFastMode,
} from "../../llm/providers/stream-wrappers/openai.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import * as fixture from "./inference-runtime.test-support.js";

const { AUTH_MARKER, MODEL, PROVIDER, SESSION_ID, config, logicalModel, params, request, setup } =
  fixture;
const transport = vi.hoisted(() => ({
  requests: [] as Record<string, unknown>[],
}));
vi.mock("openai", () => ({
  default: class {
    responses = {
      create: (payload: Record<string, unknown>) => {
        transport.requests.push(payload);
        return {
          withResponse: async () => ({
            response: new Response(null, { status: 200 }),
            data: (async function* () {
              yield {
                type: "response.completed",
                response: {
                  id: "resp_worker_tier",
                  status: "completed",
                  service_tier: "priority",
                  output: [],
                  usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
                },
              };
            })(),
          }),
        };
      },
    };
  },
}));

async function complete(runtime: ReturnType<typeof setup>, input = request()) {
  await expect(runtime.executor(params(input, vi.fn()))).resolves.toMatchObject({ type: "done" });
}

it("uses session speed and publishes a downgrade for a direct credential", async () => {
  const applyStreamPolicy = extraParamsRuntime.applyExtraParamsToAgent;
  const endpoint = { api: "openai-responses" as const, baseUrl: "https://api.openai.com/v1" };
  const model = { ...logicalModel, ...endpoint };
  const openai = { ...endpoint, auth: "api-key" as const, apiKey: AUTH_MARKER, models: [] };
  const runtimeConfig: OpenClawConfig = {
    ...config,
    models: { providers: { openai } },
  };
  const accountCatalog = createPreparedAccountCatalogAccess(() => true, undefined, runtimeConfig);
  const pluginRegistry = createEmptyPluginRegistry();
  pluginRegistry.providers.push({
    pluginId: "worker-provider",
    source: "test",
    provider: {
      id: PROVIDER,
      label: "Worker provider",
      auth: [],
      createStreamFn: () => createOpenAIResponsesTransportStreamFn(),
      wrapStreamFn: ({ streamFn, extraParams }) =>
        createOpenAIFastModeWrapper(streamFn, resolveOpenAIFastMode(extraParams)),
    },
  });
  const entry = { sessionId: SESSION_ID, updatedAt: 1, fastMode: "ultrafast" as const };
  const runtime = setup(entry, { pluginRegistry, accountCatalog, config: runtimeConfig });
  fixture.useRealProviderPreparation(runtime, () => model);
  runtime.applyStreamPolicy.mockImplementation(applyStreamPolicy);
  const route = {
    identityKey: "direct:openai",
    modelId: MODEL,
    runtimeId: "openclaw",
    api: model.api,
    baseUrl: model.baseUrl,
  };
  transport.requests.length = 0;
  await complete(runtime);
  expect(transport.requests.at(-1)?.service_tier).toBe("ultrafast");
  expect(accountCatalog.readServiceTierObservations(route)).toEqual([
    { requestedTier: "ultrafast", responseTier: "priority" },
  ]);
  for (const fastMode of [false, true]) {
    runtime.readPromptCacheContext.mockReturnValue({ boundaryCount: 0, fastMode });
    const inferenceRequest = request();
    Object.assign(inferenceRequest.options, { fastMode: "ultrafast" });
    await complete(runtime, inferenceRequest);
    expect(transport.requests.at(-1)?.service_tier).toBe(fastMode ? "priority" : undefined);
  }
});

it("uses the shared Auto deadline across repeated worker inference requests", async () => {
  const runtime = setup({ sessionId: SESSION_ID, updatedAt: 1, fastMode: false });
  runtime.readPromptCacheContext.mockReturnValue({
    boundaryCount: 0,
    fastMode: "auto",
    fastModeStartedAtMs: 100,
    fastModeAutoOnSeconds: 1,
  });
  for (const [now, enabled] of [
    [1_000, true],
    [1_101, false],
  ] as const) {
    vi.setSystemTime(now);
    await complete(runtime);
    const fastMode = runtime.applyStreamPolicy.mock.calls.at(-1)?.[4]?.fastMode;
    assert(typeof fastMode === "function", "Auto mode must retain its elapsed-time policy");
    vi.setSystemTime(now);
    expect(fastMode()).toBe(enabled);
  }
});
