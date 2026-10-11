import { describe, expect, it, vi } from "vitest";
import * as authProfileStore from "../../agents/auth-profiles/store-runtime.js";
import * as authProfileUsage from "../../agents/auth-profiles/usage.js";
import * as extraParamsRuntime from "../../agents/embedded-agent-runner/extra-params.js";
import * as modelAuth from "../../agents/model-auth.js";
import { createOpenAIResponsesTransportStreamFn } from "../../agents/openai-transport-stream.js";
import { createPreparedAccountCatalogAccess } from "../../agents/prepared-model-runtime.catalog-auth.js";
import * as providerStreamRuntime from "../../agents/provider-stream.js";
import { AuthStorage } from "../../agents/sessions/auth-storage.js";
import { ModelRegistry } from "../../agents/sessions/model-registry.js";
import * as simpleCompletionRuntime from "../../agents/simple-completion-runtime.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  createOpenAIFastModeWrapper,
  resolveOpenAIFastMode,
} from "../../llm/providers/stream-wrappers/openai.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  AUTH_MARKER,
  MODEL,
  PROVIDER,
  SESSION_ID,
  config,
  logicalModel,
  params,
  request,
  setup,
} from "./inference-runtime.test-support.js";

const transport = vi.hoisted(() => ({
  requests: [] as Record<string, unknown>[],
  echo: "ultrafast",
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
                  service_tier: transport.echo,
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

describe("worker inference account service tiers", () => {
  it("uses session speed and publishes a downgrade for a direct credential", async () => {
    const prepareModel = simpleCompletionRuntime.prepareSimpleCompletionModel;
    const applyStreamPolicy = extraParamsRuntime.applyExtraParamsToAgent;
    const registerProviderStream = providerStreamRuntime.registerProviderStreamForModel;
    const runtimeConfig: OpenClawConfig = {
      ...config,
      models: {
        providers: {
          openai: {
            api: "openai-responses",
            baseUrl: "https://api.openai.com/v1",
            auth: "api-key",
            apiKey: AUTH_MARKER,
            models: [],
          },
        },
      },
    };
    const accountCatalog = createPreparedAccountCatalogAccess(() => true, undefined, runtimeConfig);
    const model = {
      ...logicalModel,
      api: "openai-responses" as const,
      baseUrl: "https://api.openai.com/v1",
    };
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
    const authStorage = AuthStorage.inMemory({});
    const modelRegistry = ModelRegistry.inMemory(authStorage);
    vi.spyOn(authProfileStore, "ensureAuthProfileStoreAsync").mockResolvedValue({
      version: 1,
      profiles: {},
    });
    vi.spyOn(authProfileUsage, "reconcileAuthProfileQuotaBlocks").mockResolvedValue(undefined);
    vi.spyOn(modelAuth, "getApiKeyForModelCore").mockResolvedValue({
      apiKey: AUTH_MARKER,
      mode: "api-key",
      source: "worker provider fixture",
    });
    runtime.prepareModel.mockImplementation((modelParams, assertCurrent) =>
      prepareModel(
        { ...modelParams, modelResolver: async () => ({ model, authStorage, modelRegistry }) },
        assertCurrent,
      ),
    );
    runtime.applyStreamPolicy.mockImplementation(applyStreamPolicy);
    vi.mocked(providerStreamRuntime.registerProviderStreamForModel).mockImplementation(
      registerProviderStream,
    );
    const route = {
      identityKey: "direct:openai",
      modelId: MODEL,
      runtimeId: "openclaw",
      api: model.api,
      baseUrl: model.baseUrl,
    };
    transport.requests.length = 0;
    for (const echo of ["priority", "priority", "ultrafast"]) {
      transport.echo = echo;
      await expect(
        runtime.executor(params(request(), vi.fn(), runtimeConfig)),
      ).resolves.toMatchObject({
        type: "done",
      });
      expect(transport.requests.at(-1)?.service_tier).toBe("ultrafast");
      expect(accountCatalog.readServiceTierObservation(route)).toEqual(
        echo === "ultrafast" ? undefined : { requestedTier: "ultrafast", responseTier: echo },
      );
    }
    expect(runtime.prepareModel.mock.calls[0]?.[0].profileId).toBeUndefined();
    expect(
      accountCatalog.readServiceTierObservation({
        ...route,
        identityKey: "profile:openai:other",
      }),
    ).toBeUndefined();
    for (const fastMode of [false, true]) {
      runtime.readPromptCacheContext.mockReturnValue({ boundaryCount: 0, fastMode });
      const inferenceRequest = request();
      Object.assign(inferenceRequest.options, { fastMode: "ultrafast" });
      await expect(
        runtime.executor(params(inferenceRequest, vi.fn(), runtimeConfig)),
      ).resolves.toMatchObject({
        type: "done",
      });
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
      await expect(runtime.executor(params(request(), vi.fn()))).resolves.toMatchObject({
        type: "done",
      });
      const fastMode = runtime.applyStreamPolicy.mock.calls.at(-1)?.[4]?.fastMode;
      expect(typeof fastMode).toBe("function");
      if (typeof fastMode !== "function") {
        throw new Error("Auto mode did not retain its elapsed-time policy");
      }
      vi.setSystemTime(now);
      expect(fastMode()).toBe(enabled);
    }
  });
});
