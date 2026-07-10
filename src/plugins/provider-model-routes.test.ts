import { describe, expect, it, vi } from "vitest";
import type { ModelApi } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createProviderModelRoutesResolver,
  resolveProviderModelRoutes,
} from "./provider-model-routes.js";
import type { BundledProviderPolicySurface } from "./provider-policy-surface.js";

describe("provider model route adapter", () => {
  it("passes normalized config model facts before observed entry facts", () => {
    const config = {
      models: {
        providers: {
          OpenAI: {
            baseUrl: "https://provider.example.test/v1",
            models: [
              {
                id: "openai/gpt-5.5",
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
        modelId: "openai/gpt-5.5",
        api: "openai-chatgpt-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        config,
        environment: { baseUrl: "https://env.example.test/v1" },
      }),
    ).toEqual({
      kind: "routes",
      defaultRuntimeId: "openclaw",
      routes: [
        {
          api: "openai-responses",
          baseUrl: "https://model.example.test/v1",
          authRequirement: "api-key",
        },
      ],
    });
  });

  it("captures an injected alias surface once for repeated observed rows", () => {
    const resolveModelRoutes = vi.fn(
      (context: { provider: string; observed?: { api?: ModelApi | null; baseUrl?: unknown } }) => ({
        kind: "routes" as const,
        routes: [
          {
            api: context.observed?.api ?? "openai-responses",
            baseUrl:
              typeof context.observed?.baseUrl === "string"
                ? context.observed.baseUrl
                : "https://fixture.example.test/v1",
            authRequirement: "api-key" as const,
          },
        ] as const,
      }),
    );
    const surface = { resolveModelRoutes } satisfies BundledProviderPolicySurface;
    const resolveRoutes = createProviderModelRoutesResolver({
      provider: "Provider-Alias",
      surface,
    });

    expect(
      resolveRoutes({
        modelId: "demo-one",
        api: "openai-responses",
        baseUrl: "https://one.example.test/v1",
      }),
    ).toMatchObject({ routes: [{ api: "openai-responses" }] });
    expect(
      resolveRoutes({
        modelId: "demo-two",
        api: "openai-completions",
        baseUrl: "https://two.example.test/v1",
      }),
    ).toMatchObject({ routes: [{ api: "openai-completions" }] });
    expect(resolveModelRoutes).toHaveBeenCalledTimes(2);
    expect(resolveModelRoutes.mock.calls[0]?.[0]).toMatchObject({ provider: "provider-alias" });
  });

  it("prefers the exact canonical config key and keeps sources separate", () => {
    const resolveModelRoutes = vi.fn(() => ({
      kind: "routes" as const,
      routes: [
        {
          api: "openai-responses",
          baseUrl: "https://fixture.example.test/v1",
          authRequirement: "api-key" as const,
        },
      ] as const,
    }));
    const config = {
      models: {
        providers: {
          OpenAI: { baseUrl: "https://alias.example.test/v1", models: [] },
          openai: { baseUrl: "https://exact.example.test/v1", models: [] },
        },
      },
    } as unknown as OpenClawConfig;

    resolveProviderModelRoutes({
      provider: "openai",
      modelId: "gpt-5.5",
      api: "openai-completions",
      baseUrl: "https://observed.example.test/v1",
      config,
      environment: { baseUrl: "https://env.example.test/v1" },
      surface: { resolveModelRoutes },
    });

    expect(resolveModelRoutes).toHaveBeenCalledWith({
      provider: "openai",
      modelId: "gpt-5.5",
      configuredProvider: {
        api: undefined,
        baseUrl: "https://exact.example.test/v1",
      },
      environment: { baseUrl: "https://env.example.test/v1" },
      observed: {
        api: "openai-completions",
        baseUrl: "https://observed.example.test/v1",
      },
    });
  });

  it("returns null when the provider artifact has no route hook", () => {
    expect(
      resolveProviderModelRoutes({
        provider: "fixture",
        modelId: "demo",
        surface: {},
      }),
    ).toBeNull();
  });
});
