import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { PreparedModelRuntimeAuth } from "../../agents/prepared-model-runtime-auth.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  setupModelsListFixture,
  OPENCLAW_DEVICE_PLACEMENT,
  withoutOpenAIEnvAuth,
  withModelsTestState,
  catalogLoader,
  requestModelsList,
} from "./models-list.test-support.js";

// Install shared mocks before the production imports, regardless of import sorting.
await vi.hoisted(() => import("./models-list.test-support.js"));

describe("models.list", () => {
  setupModelsListFixture();

  it("keeps source-authored provider inventory when the canonical catalog is missing", async () => {
    const sourceProvider = {
      baseUrl: "https://vllm.example/v1",
      apiKey: {
        source: "file",
        provider: "mounted-json",
        id: "/providers/vllm/apiKey",
      },
      models: [
        {
          id: "source-model",
          name: "Source Model",
          contextWindow: 128_000,
          reasoning: true,
          input: ["text", "image"],
          params: { temperature: 0.2 },
          compat: { supportsDeveloperRole: false },
        },
      ],
    };
    const sourceConfig = {
      agents: {
        defaults: {
          models: {
            "vllm/allowlisted": {},
          },
        },
      },
      secrets: {
        providers: {
          "mounted-json": {
            source: "file",
            path: "/tmp/openclaw-test-secrets.json",
            mode: "json",
          },
        },
      },
      models: {
        providers: {
          vllm: sourceProvider,
        },
      },
    } as unknown as OpenClawConfig;
    const runtimeConfig = {
      ...sourceConfig,
      models: {
        providers: {
          vllm: {
            ...sourceProvider,
            apiKey: "test-key",
            models: [{ id: "runtime-only", name: "Runtime Only" }],
          },
        },
      },
    } as unknown as OpenClawConfig;
    const loadGatewayModelCatalog = catalogLoader([
      {
        id: "source-model",
        name: "Source Model",
        provider: "vllm",
        status: "disabled",
        contextWindow: 128_000,
        reasoning: true,
        input: ["text", "image"],
      },
    ]);
    setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);
    try {
      const { request, respond } = requestModelsList({
        view: "provider-config",
        runtimeConfig,
        loadGatewayModelCatalog,
      });
      await request;

      expect(respond).toHaveBeenCalledWith(
        true,
        {
          models: [
            {
              id: "source-model",
              name: "Source Model",
              provider: "vllm",
              contextWindow: 128_000,
              reasoning: true,
              input: ["text", "image"],
              available: true,
              thinkingLevels: [
                { id: "off", label: "off" },
                { id: "minimal", label: "minimal" },
                { id: "low", label: "low" },
                { id: "medium", label: "medium" },
                { id: "high", label: "high" },
                { id: "ultra", label: "ultra" },
              ],
              thinkingDefault: "medium",
            },
          ],
        },
        undefined,
      );
      expect(loadGatewayModelCatalog).toHaveBeenCalledOnce();
      expect(loadGatewayModelCatalog).toHaveBeenCalledWith(
        expect.objectContaining({ readOnly: true }),
      );
    } finally {
      clearRuntimeConfigSnapshot();
    }
  });

  it("omits unknown provider-config availability", async () => {
    const config = {
      secrets: {
        providers: {
          "mounted-json": {
            source: "file",
            path: "/tmp/openclaw-test-secrets.json",
            mode: "json",
          },
        },
      },
      models: {
        providers: {
          vllm: {
            baseUrl: "https://vllm.example/v1",
            apiKey: {
              source: "file",
              provider: "mounted-json",
              id: "/providers/vllm/apiKey",
            },
            models: [
              {
                id: "llama-secure",
                name: "Llama Secure",
                input: ["text", "image", "document"],
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;
    setRuntimeConfigSnapshot(config, config);
    try {
      const { request, respond } = requestModelsList({
        view: "provider-config",
        runtimeConfig: config,
        loadGatewayModelCatalog: catalogLoader([]),
      });
      await request;

      expect(respond).toHaveBeenCalledWith(
        true,
        {
          models: [
            {
              id: "llama-secure",
              name: "Llama Secure",
              provider: "vllm",
              input: ["text", "image", "document"],
              tags: ["default"],
            },
          ],
        },
        undefined,
      );
    } finally {
      clearRuntimeConfigSnapshot();
    }
  });

  it("reads configured rows without awaiting provider discovery", async () => {
    await withoutOpenAIEnvAuth(async () => {
      const catalog = createDeferred<never>();
      const loadGatewayModelCatalog = vi.fn(() => catalog.promise);
      const runtimeConfig = {
        models: {
          providers: {
            openai: {
              baseUrl: "https://openai.example.com",
              models: [{ id: "gpt-test", name: "GPT Test" }],
            },
          },
        },
      } as unknown as OpenClawConfig;
      const { request, respond } = requestModelsList({
        publishedCatalog: [],
        view: "configured",
        includeDefaultModels: false,
        runtimeConfig,
        loadGatewayModelCatalog,
      });
      await request;

      expect(respond).toHaveBeenCalledWith(
        true,
        {
          models: [
            {
              id: "gpt-test",
              name: "GPT Test",
              provider: "openai",
              agentRuntime: {
                id: "openclaw",
                cloudPlacementSupported: true,
                cloudPlacementExecutionMode: "worker-turn",
                devicePlacement: OPENCLAW_DEVICE_PLACEMENT,
                devicePlacementSupported: true,
                source: "implicit",
              },
              available: false,
              unavailableReason: "missing-auth",
              tags: ["default"],
            },
          ],
        },
        undefined,
      );
      expect(loadGatewayModelCatalog).not.toHaveBeenCalled();
    });
  });

  it("reads configured rows without awaiting deferred auth", async () => {
    await withoutOpenAIEnvAuth(async () => {
      const auth = createDeferred<PreparedModelRuntimeAuth>();
      const runtimeConfig = {
        models: {
          providers: {
            openai: {
              baseUrl: "https://openai.example.com",
              models: [{ id: "gpt-test", name: "GPT Test" }],
            },
          },
        },
      } as unknown as OpenClawConfig;
      const { request, respond } = requestModelsList({
        publishedCatalog: [],
        view: "configured",
        includeDefaultModels: false,
        runtimeConfig,
        deferredAuth: auth.promise,
        loadGatewayModelCatalog: vi.fn(() =>
          Promise.resolve([{ id: "gpt-test", name: "GPT Test", provider: "openai" }]),
        ),
        reqId: "req-models-list-slow-auth",
      });
      await request;

      expect(respond).toHaveBeenCalledWith(
        true,
        {
          models: [
            {
              id: "gpt-test",
              name: "GPT Test",
              provider: "openai",
              agentRuntime: {
                id: "openclaw",
                cloudPlacementSupported: true,
                cloudPlacementExecutionMode: "worker-turn",
                devicePlacement: OPENCLAW_DEVICE_PLACEMENT,
                devicePlacementSupported: true,
                source: "implicit",
              },
              available: false,
              unavailableReason: "missing-auth",
              tags: ["default"],
            },
          ],
        },
        undefined,
      );
    });
  });

  it("does not advertise a subscription route after deferred auth observes logout", async () => {
    await withoutOpenAIEnvAuth(async () => {
      const runtimeConfig = {
        models: {
          providers: {
            openai: {
              api: "openai-chatgpt-responses",
              baseUrl: "https://chatgpt.com/backend-api/codex",
              models: [{ id: "gpt-5.4", name: "GPT-5.4" }],
            },
          },
        },
      } as unknown as OpenClawConfig;
      const { request, respond } = requestModelsList({
        refresh: true,
        view: "configured",
        includeDefaultModels: false,
        runtimeConfig,
        preparedAuthModes: { openai: "oauth" },
        deferredAuth: Promise.resolve({
          authStore: { version: 1, profiles: {} },
          authModes: {},
        }),
        loadGatewayModelCatalog: catalogLoader([
          {
            id: "gpt-5.4",
            name: "GPT-5.4",
            provider: "openai",
            api: "openai-chatgpt-responses",
            baseUrl: "https://chatgpt.com/backend-api/codex",
          },
        ]),
      });

      await request;

      expect(respond).toHaveBeenCalledWith(
        true,
        {
          models: [
            expect.objectContaining({ id: "gpt-5.4", provider: "openai", available: false }),
          ],
        },
        undefined,
      );
    });
  });

  it("reads wildcard provider inventory without discovery", async () => {
    const catalog = createDeferred<never>();
    const loadGatewayModelCatalog = vi.fn(() => catalog.promise);
    const runtimeConfig = {
      agents: {
        defaults: {
          modelPolicy: { allow: ["vllm/*"] },
        },
      },
      models: {
        providers: {
          vllm: {
            baseUrl: "https://vllm.example/v1",
            models: [{ id: "llama-local", name: "Llama Local" }],
          },
        },
      },
    } as unknown as OpenClawConfig;
    const { request, respond } = requestModelsList({
      publishedCatalog: [],
      view: "provider-config",
      runtimeConfig,
      loadGatewayModelCatalog,
    });
    await request;

    expect(respond).toHaveBeenCalledWith(
      true,
      {
        models: [
          {
            id: "llama-local",
            name: "Llama Local",
            provider: "vllm",
            tags: ["default"],
          },
        ],
      },
      undefined,
    );
    expect(loadGatewayModelCatalog).not.toHaveBeenCalled();
  });

  it("keeps SecretRef configured rows unavailable without acquiring auth", async () => {
    const catalog = createDeferred<never>();
    const loadGatewayModelCatalog = vi.fn(() => catalog.promise);
    const runtimeConfig = {
      secrets: {
        providers: {
          "mounted-json": {
            source: "file",
            path: "/tmp/openclaw-test-secrets.json",
            mode: "json",
          },
        },
      },
      models: {
        providers: {
          vllm: {
            baseUrl: "https://vllm.example/v1",
            apiKey: {
              source: "file",
              provider: "mounted-json",
              id: "/providers/vllm/apiKey",
            },
            models: [{ id: "llama-secure", name: "Llama Secure" }],
          },
        },
      },
    } as unknown as OpenClawConfig;
    const { request, respond } = requestModelsList({
      publishedCatalog: [],
      view: "configured",
      includeDefaultModels: false,
      runtimeConfig,
      loadGatewayModelCatalog,
    });
    await request;

    expect(respond).toHaveBeenCalledWith(
      true,
      {
        models: [
          {
            id: "llama-secure",
            name: "Llama Secure",
            provider: "vllm",
            available: false,
            tags: ["default"],
          },
        ],
      },
      undefined,
    );
  });

  it("keeps the published all view exact while projection settles", async () => {
    await withoutOpenAIEnvAuth(async () => {
      const catalog = createDeferred<[{ id: string; name: string; provider: string }]>();
      const loadGatewayModelCatalog = vi.fn(() => catalog.promise);

      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const { request, respond } = requestModelsList({
          view: "all",
          loadGatewayModelCatalog,
        });

        await vi.advanceTimersByTimeAsync(800);
        expect(respond).not.toHaveBeenCalled();

        catalog.resolve([{ id: "gpt-test", name: "GPT Test", provider: "openai" }]);
        await request;

        expect(respond).toHaveBeenCalledWith(
          true,
          {
            models: [
              {
                id: "gpt-test",
                name: "GPT Test",
                provider: "openai",
                agentRuntime: {
                  id: "codex",
                  cloudPlacementSupported: false,
                  devicePlacementSupported: false,
                  source: "implicit",
                },
                available: false,
              },
            ],
          },
          undefined,
        );
        expect(loadGatewayModelCatalog).toHaveBeenCalledWith(
          expect.objectContaining({ readOnly: true }),
        );
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("filters provider-scoped configured views from the published catalog", async () => {
    await withoutOpenAIEnvAuth(async () => {
      const catalog = [
        { id: "claude-test", name: "Claude Test", provider: "anthropic" },
        { id: "gpt-5.4-codex", name: "GPT-5.4 Codex", provider: "openai" },
        { id: "gpt-codex-test", name: "GPT Codex Test", provider: "openai" },
        { id: "llama-local", name: "Llama Local", provider: "vllm" },
        { id: "qwen-local", name: "Qwen Local", provider: "vllm" },
      ];
      const cfg = {
        agents: {
          defaults: {
            models: {
              "openai/*": {},
              "vllm/*": {},
            },
          },
        },
        models: {
          providers: {
            openai: {
              api: "openai-responses",
              apiKey: "test-key",
              baseUrl: "https://api.openai.com/v1",
            },
            vllm: { apiKey: "test-key" },
          },
        },
      } as unknown as OpenClawConfig;

      const loadConfiguredCatalog = catalogLoader(catalog);
      const { request: configuredRequest, respond: configuredRespond } = requestModelsList({
        view: "configured",
        includeDefaultModels: false,
        runtimeConfig: cfg,
        loadGatewayModelCatalog: loadConfiguredCatalog,
      });
      await configuredRequest;

      expect(configuredRespond).toHaveBeenCalledWith(
        true,
        {
          models: [
            {
              id: "gpt-5.4",
              name: "GPT-5.4 Codex",
              provider: "openai",
              agentRuntime: {
                id: "codex",
                cloudPlacementSupported: false,
                devicePlacementSupported: false,
                source: "implicit",
              },
              available: true,
            },
            {
              id: "gpt-codex-test",
              name: "GPT Codex Test",
              provider: "openai",
              agentRuntime: {
                id: "codex",
                cloudPlacementSupported: false,
                devicePlacementSupported: false,
                source: "implicit",
              },
              available: true,
            },
            { id: "llama-local", name: "Llama Local", provider: "vllm", available: true },
            { id: "qwen-local", name: "Qwen Local", provider: "vllm", available: true },
          ],
        },
        undefined,
      );
      expect(loadConfiguredCatalog).toHaveBeenCalledWith(
        expect.objectContaining({ readOnly: true }),
      );

      const { request: allRequest, respond: allRespond } = requestModelsList({
        view: "all",
        runtimeConfig: cfg,
        loadGatewayModelCatalog: catalogLoader(catalog),
      });
      await allRequest;

      expect(allRespond).toHaveBeenCalledWith(
        true,
        {
          models: [
            {
              id: "claude-test",
              name: "Claude Test",
              provider: "anthropic",
              available: false,
              unavailableReason: "missing-auth",
            },
            {
              id: "gpt-5.4",
              name: "GPT-5.4 Codex",
              provider: "openai",
              agentRuntime: {
                id: "codex",
                cloudPlacementSupported: false,
                devicePlacementSupported: false,
                source: "implicit",
              },
              available: true,
            },
            {
              id: "gpt-codex-test",
              name: "GPT Codex Test",
              provider: "openai",
              agentRuntime: {
                id: "codex",
                cloudPlacementSupported: false,
                devicePlacementSupported: false,
                source: "implicit",
              },
              available: true,
            },
            { id: "llama-local", name: "Llama Local", provider: "vllm", available: true },
            { id: "qwen-local", name: "Qwen Local", provider: "vllm", available: true },
          ],
        },
        undefined,
      );
    });
  });

  it("keeps keyless local provider wildcard discoveries visible with unknown availability", async () => {
    await withoutOpenAIEnvAuth(async () => {
      await withModelsTestState(
        {
          env: { VLLM_API_KEY: undefined },
        },
        async () => {
          const catalog = [
            {
              id: "llama-configured",
              name: "Llama Configured",
              provider: "vllm",
              api: "openai-completions",
              baseUrl: "http://127.0.0.1:8000/v1",
            },
            {
              id: "llama-discovered",
              name: "Llama Discovered",
              provider: "vllm",
              api: "openai-completions",
              baseUrl: "http://127.0.0.1:8000/v1",
            },
          ];
          const cfg = {
            agents: { defaults: { models: { "vllm/*": {} } } },
            models: {
              providers: {
                vllm: {
                  api: "openai-completions",
                  baseUrl: "http://127.0.0.1:8000/v1",
                  models: [{ id: "llama-configured", name: "Llama Configured" }],
                },
              },
            },
          } as unknown as OpenClawConfig;
          const expected = {
            models: [
              {
                id: "llama-configured",
                name: "Llama Configured",
                provider: "vllm",
                available: true,
                tags: ["default"],
              },
              {
                id: "llama-discovered",
                name: "Llama Discovered",
                provider: "vllm",
                available: true,
              },
            ],
          };

          for (const view of ["default", "configured"] as const) {
            const { request, respond } = requestModelsList({
              view,
              includeDefaultModels: false,
              runtimeConfig: cfg,
              loadGatewayModelCatalog: catalogLoader(catalog),
            });
            await request;
            expect(respond).toHaveBeenCalledWith(true, expected, undefined);
          }
        },
      );
    });
  });
});
