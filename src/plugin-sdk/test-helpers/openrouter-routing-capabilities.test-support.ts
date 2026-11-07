// Core-owned OpenRouter integration behind the existing focused provider contract.
// Runtime setup stays lazy so other provider contracts do not load this fixture.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ProviderRuntimeHooks } from "../../agents/embedded-agent-runner/model.provider-hooks.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { ProviderRuntimeContractPluginLoader } from "./provider-runtime-contract.types.js";

export function describeOpenRouterRoutingCapabilitiesContract(
  load: ProviderRuntimeContractPluginLoader,
) {
  const baseId = "openai/gpt-5.2";
  const row = {
    id: baseId,
    name: "Synthetic routing capability model",
    context_length: 456789,
    top_provider: { max_completion_tokens: 23456 },
    architecture: { modality: "text+image->text", input_modalities: ["text", "image"] },
    supported_parameters: ["reasoning", "tools"],
    pricing: { prompt: "0.000002", completion: "0.000008" },
  };
  const providerConfig = {
    api: "openai-completions" as const,
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: "synthetic-routing-test-key",
    models: [],
  };
  const catalogVariants = ["free", "batch", "thinking", "extended"];
  const rows = [
    row,
    { ...row, id: baseId + ":floor:online", context_length: 333333 },
    ...catalogVariants.map((suffix, index) => ({
      ...row,
      id: baseId + ":" + suffix,
      context_length: 10000 + index,
    })),
  ];

  describe("OpenRouter routing variants through runtime resolution", () => {
    let state: OpenClawTestState;
    let cfg: OpenClawConfig;
    let runtimeHooks: ProviderRuntimeHooks;
    let runtime: typeof import("../../agents/embedded-agent-runner/model.js");
    const fetchCatalog = vi.fn(async () => Response.json({ data: rows }));

    beforeAll(async () => {
      vi.stubGlobal("fetch", fetchCatalog);
      runtime = await import("../../agents/embedded-agent-runner/model.js");
      const { createOpenClawTestState } = await import("../../test-utils/openclaw-test-state.js");
      const { loadOpenRouterModelCapabilities, getLoadedOpenRouterModelCapabilities } =
        await import("../../agents/embedded-agent-runner/openrouter-model-capabilities.js");
      const { resolveRuntimeHooks } =
        await import("../../agents/embedded-agent-runner/model.provider-hooks.js");
      const { registerSingleProviderPlugin } = await import("../plugin-test-runtime.js");
      state = await createOpenClawTestState({
        prepareProfileCatalog: false,
        prefix: "openrouter-routing-variants-",
        env: {
          OPENROUTER_API_KEY: "synthetic-routing-test-key",
          HTTP_PROXY: undefined,
          HTTPS_PROXY: undefined,
          ALL_PROXY: undefined,
        },
      });
      cfg = { models: { providers: { openrouter: providerConfig } } };
      await state.writeConfig(cfg);
      // Register the production provider in this test's module graph. Native plugin
      // imports use a different fetch global under Vitest; do not mock the cache.
      const { default: plugin } = await load();
      const provider = await registerSingleProviderPlugin(plugin);
      runtimeHooks = {
        ...resolveRuntimeHooks({ skipProviderRuntimeHooks: true }),
        prepareProviderDynamicModel: async ({ context }) => {
          await provider.prepareDynamicModel?.(context);
          return provider.resolveDynamicModel?.(context) ?? undefined;
        },
        runProviderDynamicModel: ({ context }) =>
          provider.resolveDynamicModel?.(context) ?? undefined,
      };
      await loadOpenRouterModelCapabilities(baseId);
      expect(fetchCatalog).toHaveBeenCalled();
      expect(getLoadedOpenRouterModelCapabilities(baseId)?.contextWindow).toBe(456789);
    }, 60000);

    afterAll(async () => {
      vi.unstubAllGlobals();
      await state?.cleanup();
    });

    async function resolve(requested: string, config = cfg) {
      const result = await runtime.resolveModelAsync(
        "openrouter",
        requested,
        state.agentDir(),
        config,
        {
          ...runtime.createEmptyAgentDiscoveryStores(),
          runtimeHooks,
          workspaceDir: state.workspaceDir,
        },
      );
      if (!result.model) {
        throw new Error(result.error);
      }
      return result.model;
    }

    it.each(["nitro", "floor", "exacto", "online", "nitro:exacto", "nitro:floor:exacto:online"])(
      "inherits capabilities for %s without changing the requested ID or refetching",
      async (suffix) => {
        const requested = baseId + ":" + suffix;
        const count = fetchCatalog.mock.calls.length;
        expect(await resolve(requested)).toMatchObject({
          id: requested,
          contextWindow: 456789,
          maxTokens: 23456,
          reasoning: true,
          input: ["text", "image"],
        });
        expect(fetchCatalog).toHaveBeenCalledTimes(count);
      },
      60000,
    );

    it("sends the unchanged routing ID through the production HTTP transport", async () => {
      const { createServer } = await import("node:http");
      const { createOpenAICompletionsTransportStreamFn } = await import("@openclaw/ai/transports");
      const { reserveTestPortListener } = await import("../../test-utils/port-claims.js");
      const { runQaGatewayFixture } = await import("../../../test/helpers/qa-gateway-cleanup.js");
      const requested = baseId + ":nitro:exacto";
      const model = await resolve(requested);
      let wireModel: unknown;
      let wirePath: unknown;
      const reservation = await reserveTestPortListener({
        offsets: [0],
        createListener: () =>
          createServer((request, response) => {
            async function handleRequest() {
              request.setEncoding("utf8");
              let body = "";
              for await (const chunk of request) {
                body += chunk;
              }
              wirePath = request.url;
              wireModel = JSON.parse(body).model;
              const chunk = {
                id: "synthetic",
                object: "chat.completion.chunk",
                created: 0,
                model: requested,
                choices: [
                  { index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: "stop" },
                ],
              };
              response.writeHead(200, { "content-type": "text/event-stream" });
              response.end("data: " + JSON.stringify(chunk) + "\n\ndata: [DONE]\n\n");
            }
            void handleRequest().catch(() => {
              response.destroy();
            });
          }),
      });
      await runQaGatewayFixture(
        async () => {
          const stream = await createOpenAICompletionsTransportStreamFn()(
            {
              ...model,
              api: "openai-completions",
              baseUrl: "http://127.0.0.1:" + reservation.claim.port + "/v1",
            },
            { messages: [{ role: "user", content: "synthetic wire proof", timestamp: 0 }] },
            { apiKey: "synthetic-routing-test-key" },
          );
          const answer = await stream.result();
          expect(answer.errorMessage).toBeUndefined();
          expect(answer.stopReason).toBe("stop");
          expect(answer.content).toEqual([{ type: "text", text: "ok" }]);
          expect(wirePath).toBe("/v1/chat/completions");
          expect(wireModel).toBe(requested);
        },
        async () => {
          reservation.listener.closeAllConnections();
          await reservation.releaseListener();
        },
        reservation.claim.release,
      );
    });

    it("prefers an exact suffixed catalog row", async () => {
      expect(await resolve(baseId + ":floor:online")).toMatchObject({
        id: baseId + ":floor:online",
        contextWindow: 333333,
      });
    });

    it.each(catalogVariants)(
      "preserves distinct catalog variant %s in both suffix orders",
      async (suffix) => {
        const contextWindow = 10000 + catalogVariants.indexOf(suffix);
        for (const id of [
          baseId + ":" + suffix,
          baseId + ":" + suffix + ":nitro",
          baseId + ":nitro:" + suffix,
        ]) {
          expect(await resolve(id)).toMatchObject({ id, contextWindow });
        }
      },
    );

    it.each([baseId + ":unknown", baseId + ":unknown:nitro", "unknown/model:nitro"])(
      "does not invent a base for %s",
      async (id) => {
        expect(await resolve(id)).toMatchObject({
          id,
          contextWindow: 200000,
          maxTokens: 8192,
          reasoning: false,
          input: ["text"],
        });
      },
    );

    it("keeps custom endpoints out of routing fallback", async () => {
      const config: OpenClawConfig = {
        models: {
          providers: {
            openrouter: {
              ...providerConfig,
              baseUrl: "https://proxy.example/api/v1",
              models: [],
            },
          },
        },
      };
      expect(await resolve(baseId + ":nitro", config)).toMatchObject({
        id: baseId + ":nitro",
        baseUrl: "https://proxy.example/api/v1",
        contextWindow: 200000,
        maxTokens: 8192,
        reasoning: false,
        input: ["text"],
      });
    });

    it("preserves operator-authored model fields", async () => {
      const id = baseId + ":nitro";
      const authored = {
        id,
        name: "Operator model",
        contextWindow: 98765,
        maxTokens: 5432,
        reasoning: false,
        input: ["text" as const],
        cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
      };
      const config: OpenClawConfig = {
        models: {
          providers: { openrouter: { ...providerConfig, models: [authored] } },
        },
      };
      expect(await resolve(id, config)).toMatchObject(authored);
    });
  });
}
