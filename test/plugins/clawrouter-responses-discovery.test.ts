import { createOpenAIResponsesTransportStreamFn } from "@openclaw/ai/transports";
import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { afterEach, assert, beforeEach, expect, it, vi } from "vitest";
import clawrouter from "../../extensions/clawrouter/index.js";
import { sseResponse } from "../../packages/ai/src/transports/openai-responses-prompt-observer.test-support.js";
import { completedResponse } from "../../packages/ai/src/transports/openai-stream-cases.test-support.js";
import {
  createEmptyAgentDiscoveryStores,
  resolveModelAsync,
} from "../../src/agents/embedded-agent-runner/model.js";
import type { ProviderRuntimeHooks } from "../../src/agents/embedded-agent-runner/model.provider-hooks.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import { createOpenClawTestState } from "../../src/test-utils/openclaw-test-state.js";
import { registerSingleProviderPlugin } from "../../src/test-utils/plugin-registration.js";

const auth = vi.hoisted(() => ({ resolveApiKeyForProvider: vi.fn() }));
vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => auth);

let state: Awaited<ReturnType<typeof createOpenClawTestState>>;

beforeEach(async () => {
  state = await createOpenClawTestState({ label: "clawrouter-responses" });
  clearLiveCatalogCacheForTests();
  auth.resolveApiKeyForProvider.mockReset();
  auth.resolveApiKeyForProvider.mockResolvedValue({ apiKey: "synthetic-catalog-key" });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  clearLiveCatalogCacheForTests();
  await state.cleanup();
});

it.each([
  { efforts: ["low", "high"], reasoning: true, role: "developer" },
  { efforts: undefined, reasoning: false, role: "system" },
])(
  "ClawRouter dispatch uses $role for a discovered reasoning=$reasoning model",
  async ({ efforts, reasoning, role }) => {
    const baseUrl = "https://broker.example.test/private";
    const config: OpenClawConfig = {
      models: {
        providers: { clawrouter: { baseUrl, agentRuntime: { id: "openclaw" }, models: [] } },
      },
    };
    const requests: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = request.url;
      if (url === `${baseUrl}/v1/catalog`) {
        expect(request.headers.get("authorization")).toBe("Bearer synthetic-catalog-key");
        const model = {
          id: "synthetic-opaque",
          displayName: "Synthetic name",
          upstream: "synthetic-opaque",
          capabilities: ["llm.responses"],
          ...(efforts ? { supportedReasoningEfforts: efforts } : {}),
        };
        const catalogProvider = {
          id: "private",
          openaiCompatible: true,
          nativeBaseUrl: "/v1/native/private",
          routes: [],
          models: [model],
        };
        return Response.json({ providers: [catalogProvider] });
      }
      expect(url).toBe(`${baseUrl}/v1/responses`);
      requests.push(await request.json());
      return sseResponse([completedResponse("resp_synthetic", [])]);
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = await registerSingleProviderPlugin(clawrouter);
    const runtimeHooks: ProviderRuntimeHooks = {
      prepareProviderDynamicModel: async ({ context }) =>
        await provider.prepareDynamicModel?.(context),
      runProviderDynamicModel: ({ context }) => provider.resolveDynamicModel?.(context),
      shouldPreferProviderRuntimeResolvedModel: ({ context }) =>
        provider.preferRuntimeResolvedModel?.(context) ?? false,
      normalizeProviderResolvedModelWithPlugin: ({ context }) =>
        provider.normalizeResolvedModel?.(context),
      buildProviderUnknownModelHintWithPlugin: () => undefined,
      normalizeProviderTransportWithPlugin: () => undefined,
    };
    const resolved = await resolveModelAsync(
      "clawrouter",
      "synthetic-opaque",
      state.agentDir(),
      config,
      {
        ...createEmptyAgentDiscoveryStores(),
        workspaceDir: state.workspaceDir,
        authProfileId: "clawrouter:synthetic",
        authProfileMode: "api_key",
        runtimeHooks,
        skipAgentDiscovery: true,
      },
    );
    expect(resolved.error).toBeUndefined();
    expect(resolved.model).toMatchObject({
      id: "synthetic-opaque",
      name: "Synthetic name",
      api: "openai-responses",
      reasoning,
    });
    expect(auth.resolveApiKeyForProvider).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: "clawrouter:synthetic", lockedProfile: true }),
    );
    assert(resolved.model, "discovered model missing");
    const stream = provider.wrapStreamFn?.({
      config,
      provider: "clawrouter",
      modelId: resolved.model.id,
      streamFn: createOpenAIResponsesTransportStreamFn(),
    });
    assert(stream, "provider stream missing");
    const responseStream = await stream(
      resolved.model,
      {
        systemPrompt: "Synthetic instructions",
        messages: [{ role: "user", content: "Hello", timestamp: 1 }],
      },
      { apiKey: "synthetic-catalog-key" },
    );
    const result = await responseStream.result();
    expect(result.stopReason).not.toBe("error");
    expect(requests).toMatchObject([
      {
        model: "synthetic-opaque",
        input: [
          {
            type: "message",
            role,
            content: [{ type: "input_text", text: "Synthetic instructions" }],
          },
          { type: "message", role: "user" },
        ],
      },
    ]);
  },
);
