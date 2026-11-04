import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configForProviders, modelDefinition } from "../agents/model-auth.fixtures.test-support.js";
import * as sourceProjection from "../config/runtime-source-projection.js";
import type { ModelProviderConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ProviderResolveModelRoutesContext } from "../plugin-sdk/provider-model-types.js";
import {
  createProviderModelRoutesResolver,
  resolveProviderModelCatalogId,
  resolveProviderModelRoutes,
} from "./provider-model-routes.js";

afterEach(() => vi.restoreAllMocks());

function createIndeterminateRouteMock() {
  return vi.fn((_context: ProviderResolveModelRoutesContext) => ({
    kind: "indeterminate" as const,
  }));
}

const openaiConfig = <Provider extends Parameters<typeof configForProviders>[0][string]>(
  openai: Provider,
) => configForProviders({ openai });

describe("provider model route adapter", () => {
  const resolveModelRoutes = createIndeterminateRouteMock();
  beforeEach(() => resolveModelRoutes.mockClear());
  const expectContext = (context: Partial<ProviderResolveModelRoutesContext>) =>
    expect(resolveModelRoutes).toHaveBeenCalledWith({
      provider: "openai",
      requestTransportOverrides: "none",
      env: {},
      ...context,
    });
  const resolve = (options: Parameters<typeof resolveProviderModelRoutes>[0]) =>
    resolveProviderModelRoutes({ env: {}, surface: { resolveModelRoutes }, ...options });
  it.each(["present", undefined] as const)(
    "projects authored overrides only when the request has not already established them (%s)",
    (requestTransportOverrides) => {
      const project = vi.spyOn(sourceProjection, "projectConfigOntoRuntimeSourceSnapshot");
      const resolveRoutes = createProviderModelRoutesResolver({
        provider: "fixture",
        requestTransportOverrides,
        config: configForProviders({
          fixture: {
            baseUrl: "https://provider.example.test/v1",
            headers: { "x-route": "custom" },
            models: [],
          },
        }),
        env: {},
        surface: { resolveModelRoutes },
      });
      resolveRoutes({ modelId: "first" });
      resolveRoutes({ modelId: "second" });
      expect(project).toHaveBeenCalledTimes(requestTransportOverrides === "present" ? 0 : 1);
      expect(
        resolveModelRoutes.mock.calls.map(([context]) => context.requestTransportOverrides),
      ).toEqual(["present", "present"]);
    },
  );

  it("forwards a non-chat capability without inventing route intent", () => {
    resolve({
      provider: "fixture",
      modelId: "native",
      capability: "decision",
    });
    expectContext({
      provider: "fixture",
      modelId: "native",
      capability: "decision",
    });
  });
  it.each(["explicit", "inherited"] as const)(
    "preserves %s consumer intent precedence against a provider pin",
    (source) => {
      resolve({
        provider: "openai",
        modelId: "gpt-5.4-mini",
        config: openaiConfig({
          baseUrl: "https://api.openai.com/v1",
          models: [],
          agentRuntime: { id: "openclaw" },
        }),
        routeIntent: { runtimeId: "codex", authRequirement: "subscription", source },
      });
      expect(resolveModelRoutes.mock.calls[0]?.[0]).toMatchObject({
        routeIntent:
          source === "explicit"
            ? { runtimeId: "codex", authRequirement: "subscription", source }
            : { runtimeId: "openclaw", source: "explicit" },
      });
    },
  );

  it("projects an explicit model runtime pin without treating the adapter as a pin", () => {
    const config: OpenClawConfig = openaiConfig({
      baseUrl: "https://api.openai.com/v1",
      api: "openai-completions",
      models: [modelDefinition("gpt-5.4-mini", { agentRuntime: { id: "openclaw" } })],
    });
    resolve({ provider: "openai", config, modelId: "gpt-5.4-mini" });
    expect(resolveModelRoutes.mock.calls[0]?.[0]).toMatchObject({
      routeIntent: { runtimeId: "openclaw", source: "explicit" },
    });
  });

  it("does not invent an observed transport from a model id alone", () => {
    const routeHook = vi.fn((_context: ProviderResolveModelRoutesContext) => ({
      kind: "indeterminate" as const,
      defaultRuntimeId: "codex",
    }));
    const resolveRoutes = createProviderModelRoutesResolver({
      provider: "openai",
      config: {},
      surface: { resolveModelRoutes: routeHook },
    });

    expect(resolveRoutes({ modelId: "gpt-5.4-nano" })).toEqual({
      kind: "indeterminate",
      defaultRuntimeId: "codex",
    });
    expect(routeHook).toHaveBeenCalledWith({
      provider: "openai",
      modelId: "gpt-5.4-nano",
      requestTransportOverrides: "none",
      env: process.env,
    });
    expect(routeHook.mock.calls[0]?.[0].env).toBe(process.env);
  });

  it("does not treat namespaced custom providers as bundled route artifacts", () => {
    const provider = "my-ngc:nvidia";
    const modelId = "nvidia/nemotron-3-ultra-550b-a55b";
    const config = configForProviders({
      [provider]: {
        api: "openai-completions",
        baseUrl: "https://provider.example.test/v1",
        models: [modelDefinition(modelId)],
      },
    });

    expect(resolveProviderModelCatalogId({ provider, modelId })).toBeNull();
    expect(resolveProviderModelRoutes({ provider, modelId, config, env: {} })).toBeNull();
  });

  it("preserves provider-scoped nested ids through route resolution", () => {
    const config = openaiConfig({
      models: [
        modelDefinition("openai/acme-model", {
          api: "openai-completions",
          baseUrl: "https://acme.example.test/v1",
        }),
      ],
    }) as unknown as OpenClawConfig;

    resolveProviderModelRoutes({
      provider: "openai",
      modelId: "openai/acme-model",
      config,
      env: {},
      surface: {
        normalizeModelCatalogId: ({ modelId }) => modelId,
        resolveModelRoutes,
      },
    });

    expectContext({
      modelId: "openai/acme-model",
      configuredModel: {
        api: "openai-completions",
        baseUrl: "https://acme.example.test/v1",
      },
      configuredProvider: { api: undefined, baseUrl: undefined },
    });
  });

  it("keeps configured model facts ahead of observed route facts", () => {
    const config = openaiConfig({
      baseUrl: "https://provider.example.test/v1",
      models: [
        {
          ...modelDefinition("gpt-5.5"),
          api: "openai-responses",
          baseUrl: "https://model.example.test/v1",
        },
      ],
    });

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
    expectContext({
      modelId: "gpt-future-observed",
      observedRoutes,
    });
  });

  it("locks configured route facts while keeping the environment live", () => {
    const configuredModel = modelDefinition("demo", {
      api: "openai-responses",
      baseUrl: "https://model-one.example.test/v1",
    });
    const configuredProvider: ModelProviderConfig = {
      api: "openai-completions",
      baseUrl: "https://provider-one.example.test/v1",
      models: [configuredModel],
    };
    const config = openaiConfig(configuredProvider);
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

    expectContext({
      modelId: "demo",
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
    const resolveRoutes = createProviderModelRoutesResolver({
      provider: "openai",
      env: {},
      config: {
        models: {
          providers: {
            openai: {
              models: [
                { ...modelDefinition("gpt-5.4"), api: "openai-responses", headers: firstHeaders },
                {
                  ...modelDefinition("gpt-5.4-codex"),
                  api: "openai-completions",
                  baseUrl: "https://model.example.test/v1",
                  headers: { "x-later-row": "ignored" },
                },
                { ...modelDefinition("second"), params: { azureApiVersion: "2025-01-01" } },
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

    resolve({
      provider: "openai",
      modelId: "Foo",
      config,
    });
    expect(resolveModelRoutes.mock.calls[0]?.[0]).toMatchObject({
      modelId: "Foo",
      configuredProvider: { api: "openai-completions" },
    });
    expect(resolveModelRoutes.mock.calls[0]?.[0]).not.toHaveProperty("configuredModel");

    resolve({
      provider: "openai",
      modelId: "foo",
      config,
    });
    expect(resolveModelRoutes.mock.calls[1]?.[0]).toMatchObject({
      modelId: "foo",
      configuredModel: { api: "openai-chatgpt-responses" },
    });
  });

  it.each([
    ["provider headers", { headers: { "x-route": "custom" } }, {}],
    ["provider request", { request: { allowPrivateNetwork: true } }, {}],
    ["provider local service", { localService: { command: "/custom-provider" } }, {}],
    ["provider auth header", { authHeader: false }, {}],
    ["model headers", {}, { headers: { "x-model-route": "custom" } }],
  ])("projects %s without exposing its value", (_label, providerPatch, modelPatch) => {
    const config = openaiConfig({
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      ...providerPatch,
      models: [{ ...modelDefinition("gpt-5.5"), ...modelPatch }],
    });

    resolve({
      provider: "openai",
      modelId: "gpt-5.5",
      config,
    });

    expect(resolveModelRoutes.mock.calls[0]?.[0]).toMatchObject({
      requestTransportOverrides: "present",
    });
  });

  it.each([
    ["missing", undefined],
    ["null", null],
  ] as const)("returns null for a %s route surface despite configured facts", (_label, surface) => {
    const config = configForProviders({
      "fixture:routes": {
        api: "openai-completions",
        baseUrl: "https://provider.example.test/v1",
        models: [{ ...modelDefinition("demo"), api: "openai-responses" }],
      },
    });

    expect(
      resolveProviderModelRoutes({
        provider: "fixture:routes",
        modelId: "demo",
        api: "openai-responses",
        baseUrl: "https://observed.example.test/v1",
        config,
        env: {},
        surface,
      }),
    ).toBeNull();
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
