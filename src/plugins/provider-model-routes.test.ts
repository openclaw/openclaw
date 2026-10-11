import { describe, expect, it, vi } from "vitest";
import type { ModelApi } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ProviderResolveModelRoutesContext } from "../plugin-sdk/provider-model-types.js";
import {
  createProviderModelRoutesResolver,
  resolveProviderModelRoutes,
} from "./provider-model-routes.js";

describe("provider model route adapter", () => {
  it.each(["explicit", "inherited"] as const)(
    "preserves %s consumer intent precedence against a provider pin",
    (source) => {
      const resolveModelRoutes = vi.fn((_context: ProviderResolveModelRoutesContext) => ({
        kind: "indeterminate" as const,
      }));
      resolveProviderModelRoutes({
        provider: "openai",
        modelId: "gpt-5.4-mini",
        config: {
          models: {
            providers: {
              openai: {
                baseUrl: "https://api.openai.com/v1",
                models: [],
                agentRuntime: { id: "openclaw" },
              },
            },
          },
        },
        routeIntent: { runtimeId: "codex", authRequirement: "subscription", source },
        env: {},
        surface: { resolveModelRoutes },
      });
      expect(resolveModelRoutes.mock.calls[0]?.[0]).toMatchObject({
        routeIntent:
          source === "explicit"
            ? { runtimeId: "codex", authRequirement: "subscription", source }
            : { runtimeId: "openclaw", source: "explicit" },
      });
    },
  );

  it.each(["provider", "model"] as const)(
    "projects an explicit %s runtime pin without treating the adapter as a pin",
    (scope) => {
      const resolveModelRoutes = vi.fn((_context: ProviderResolveModelRoutesContext) => ({
        kind: "indeterminate" as const,
      }));
      const config: OpenClawConfig = {
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              api: "openai-completions",
              ...(scope === "provider" ? { agentRuntime: { id: "openclaw" } } : {}),
              models: [
                {
                  id: "gpt-5.4-mini",
                  name: "Small model",
                  reasoning: false,
                  input: ["text"],
                  maxTokens: 4096,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  ...(scope === "model" ? { agentRuntime: { id: "openclaw" } } : {}),
                },
              ],
            },
          },
        },
      };
      resolveProviderModelRoutes({
        provider: "openai",
        modelId: "gpt-5.4-mini",
        config,
        env: {},
        surface: { resolveModelRoutes },
      });
      expect(resolveModelRoutes.mock.calls[0]?.[0]).toMatchObject({
        routeIntent: { runtimeId: "openclaw", source: "explicit" },
      });
    },
  );

  it("keeps configured model facts ahead of observed route facts", () => {
    const config = {
      models: {
        providers: {
          openai: {
            baseUrl: "https://provider.example.test/v1",
            models: [
              {
                id: "gpt-5.5",
                api: "openai-responses",
                baseUrl: "https://model.example.test/v1",
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    expect(
      resolveProviderModelRoutes({
        provider: "OPENAI",
        modelId: "gpt-5.5",
        api: "openai-chatgpt-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        config,
        env: { OPENAI_BASE_URL: "https://env.example.test/v1" },
      }),
    ).toEqual({
      kind: "routes",
      defaultRuntimeId: "openclaw",
      routes: [
        {
          api: "openai-responses",
          baseUrl: "https://model.example.test/v1",
          authRequirement: "api-key",
          requestTransportOverrides: "none",
          runtimePolicy: { compatibleIds: ["openclaw"] },
        },
      ],
    });
  });

  it("forwards one reversed physical route group in one artifact call", () => {
    const resolveModelRoutes = vi.fn((_context: ProviderResolveModelRoutesContext) => ({
      kind: "indeterminate" as const,
    }));
    const resolveRoutes = createProviderModelRoutesResolver({
      provider: "openai",
      env: {},
      surface: { resolveModelRoutes },
    });
    const observedRoutes = [
      {
        api: "openai-chatgpt-responses" as const,
        baseUrl: "https://chatgpt.com/backend-api/codex",
      },
      { api: "openai-responses" as const, baseUrl: "https://api.openai.com/v1" },
    ];

    resolveRoutes({ modelId: "gpt-future-observed", observedRoutes });

    expect(resolveModelRoutes).toHaveBeenCalledOnce();
    expect(resolveModelRoutes).toHaveBeenCalledWith({
      provider: "openai",
      modelId: "gpt-future-observed",
      requestTransportOverrides: "none",
      env: {},
      observedRoutes,
    });
  });

  it("locks configured route facts while keeping the environment live", () => {
    const resolveModelRoutes = vi.fn((_context: ProviderResolveModelRoutesContext) => ({
      kind: "indeterminate" as const,
    }));
    const configuredModel: {
      id: string;
      api: ModelApi;
      baseUrl: string;
    } = {
      id: "demo",
      api: "openai-responses",
      baseUrl: "https://model-one.example.test/v1",
    };
    const configuredProvider: {
      api: ModelApi;
      baseUrl: string;
      authHeader?: boolean;
      models: Array<typeof configuredModel>;
    } = {
      api: "openai-completions",
      baseUrl: "https://provider-one.example.test/v1",
      models: [configuredModel],
    };
    const config = {
      models: { providers: { openai: configuredProvider } },
    } as unknown as OpenClawConfig;
    const env = { OPENAI_BASE_URL: "https://env-one.example.test/v1" };
    const resolveRoutes = createProviderModelRoutesResolver({
      provider: "openai",
      config,
      env,
      surface: { resolveModelRoutes },
    });

    configuredModel.api = "openai-completions";
    configuredModel.baseUrl = "https://model-two.example.test/v1";
    configuredProvider.api = "openai-responses";
    configuredProvider.authHeader = false;
    configuredProvider.baseUrl = "https://provider-two.example.test/v1";
    env.OPENAI_BASE_URL = "https://env-two.example.test/v1";
    resolveRoutes({ modelId: "demo" });

    expect(resolveModelRoutes).toHaveBeenCalledWith({
      provider: "openai",
      modelId: "demo",
      requestTransportOverrides: "none",
      configuredModel: {
        api: "openai-responses",
        baseUrl: "https://model-one.example.test/v1",
      },
      configuredProvider: {
        api: "openai-completions",
        baseUrl: "https://provider-one.example.test/v1",
      },
      env: { OPENAI_BASE_URL: "https://env-two.example.test/v1" },
    });
    expect(resolveModelRoutes.mock.calls[0]?.[0].env).toBe(env);
  });

  it("captures separate override facts for canonical duplicate rows", () => {
    const firstHeaders: Record<string, string> = {};
    const resolveModelRoutes = vi.fn((_context: ProviderResolveModelRoutesContext) => ({
      kind: "indeterminate" as const,
    }));
    const resolveRoutes = createProviderModelRoutesResolver({
      provider: "openai",
      env: {},
      config: {
        models: {
          providers: {
            openai: {
              models: [
                { id: "gpt-5.4", api: "openai-responses", headers: firstHeaders },
                {
                  id: "gpt-5.4-codex",
                  api: "openai-completions",
                  baseUrl: "https://model.example.test/v1",
                  headers: { "x-later-row": "ignored" },
                },
                { id: "second", params: { azureApiVersion: "2025-01-01" } },
              ],
            },
          },
        },
      } as unknown as OpenClawConfig,
      surface: {
        normalizeModelCatalogId: ({ modelId }) =>
          modelId === "gpt-5.4-codex" ? "gpt-5.4" : modelId,
        resolveModelRoutes,
      },
    });

    firstHeaders["x-after-preparation"] = "not part of the prepared route";
    for (const modelId of ["gpt-5.4-codex", "second", "missing"]) {
      resolveRoutes({ modelId });
    }
    expect(
      resolveModelRoutes.mock.calls.map(([context]) => [
        context.modelId,
        context.requestTransportOverrides,
      ]),
    ).toEqual([
      ["gpt-5.4", "none"],
      ["second", "present"],
      ["missing", "none"],
    ]);
    expect(resolveModelRoutes.mock.calls[0]?.[0].configuredModel).toEqual({
      api: "openai-responses",
      baseUrl: "https://model.example.test/v1",
    });
  });

  it("keeps case-distinct provider keys and unknown model ids separate", () => {
    const resolveModelRoutes = vi.fn((_context: ProviderResolveModelRoutesContext) => ({
      kind: "indeterminate" as const,
    }));
    const config = {
      models: {
        providers: {
          OpenAI: {
            baseUrl: "https://case-fallback.example.test/v1",
            models: [{ id: "Foo", api: "openai-responses" }],
          },
          openai: {
            api: "openai-completions",
            models: [{ id: "foo", api: "openai-chatgpt-responses" }],
          },
        },
      },
    } as unknown as OpenClawConfig;

    resolveProviderModelRoutes({
      provider: "openai",
      modelId: "Foo",
      config,
      env: {},
      surface: { resolveModelRoutes },
    });
    expect(resolveModelRoutes.mock.calls[0]?.[0]).toMatchObject({
      modelId: "Foo",
      configuredProvider: { api: "openai-completions" },
    });
    expect(resolveModelRoutes.mock.calls[0]?.[0]).not.toHaveProperty("configuredModel");

    resolveProviderModelRoutes({
      provider: "openai",
      modelId: "foo",
      config,
      env: {},
      surface: { resolveModelRoutes },
    });
    expect(resolveModelRoutes.mock.calls[1]?.[0]).toMatchObject({
      modelId: "foo",
      configuredModel: { api: "openai-chatgpt-responses" },
    });
  });

  it("keeps a missing route hook captured while fresh resolvers see a later hook", () => {
    const surface: { resolveModelRoutes?: () => { kind: "indeterminate" } } = {};
    const resolveRoutes = createProviderModelRoutesResolver({ provider: "fixture", surface });
    surface.resolveModelRoutes = () => ({ kind: "indeterminate" });

    expect(resolveRoutes({ modelId: "demo" })).toBeNull();
    expect(resolveProviderModelRoutes({ provider: "fixture", modelId: "demo", surface })).toEqual({
      kind: "indeterminate",
    });
  });
});
