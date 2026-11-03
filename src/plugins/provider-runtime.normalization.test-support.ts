import { expect, it, type Mock } from "vitest";
import { PROVIDER_RUNTIME_TEST_MODEL as MODEL } from "./provider-runtime.test-support.js";
import type { ProviderPlugin } from "./types.js";

type NormalizationTestContext = {
  runtime: typeof import("./provider-runtime.js");
  normalizeDiscoveredAgentModel: typeof import("../agents/model-discovery-normalize.js").normalizeDiscoveredAgentModel;
  resolvePluginProvidersMock: Mock<
    typeof import("./providers.runtime.js").resolvePluginProvidersCore
  >;
  createDemoProvider: (overrides: Partial<ProviderPlugin>) => ProviderPlugin;
};

export function registerProviderNormalizationTests(getContext: () => NormalizationTestContext) {
  it.each(["unchanged", "ID-only", "provider-only", "replacement"] as const)(
    "shares catalog normalization selection for %s model changes",
    (change) => {
      const { normalizeDiscoveredAgentModel, resolvePluginProvidersMock, createDemoProvider } =
        getContext();
      const inPlace = change.endsWith("-only");
      const provider =
        change === "provider-only" || change === "replacement"
          ? "normalized-provider"
          : MODEL.provider;
      const id = change === "ID-only" || change === "replacement" ? "normalized" : MODEL.id;
      const transport =
        (owner: string): NonNullable<ProviderPlugin["normalizeTransport"]> =>
        ({ provider: transportProvider, modelId, api }) => ({
          baseUrl: `https://transport.example/${owner}/${transportProvider}/${modelId}/${api}`,
        });
      const original = createDemoProvider({
        normalizeResolvedModel: ({ model }) => {
          const normalized = { ...model, provider, id, api: "openai-completions" as const };
          return inPlace ? Object.assign(model, normalized) : normalized;
        },
        normalizeTransport: transport("original"),
      });
      const selected = createDemoProvider({
        id: provider,
        normalizeTransport: transport("selected"),
      });
      resolvePluginProvidersMock.mockImplementation((params) =>
        params.providerRefs?.includes("normalized-provider") ||
        params.modelRefs?.includes("demo/normalized")
          ? [selected]
          : [original],
      );
      const lookupProvider = inPlace ? provider : MODEL.provider;
      const lookupId = inPlace ? id : MODEL.id;
      const owner = inPlace ? "selected" : "original";
      expect(normalizeDiscoveredAgentModel({ ...MODEL }, "/fixture/agent")).toMatchObject({
        provider,
        id,
        api: "openai-completions",
        baseUrl: `https://transport.example/${owner}/${lookupProvider}/${lookupId}/openai-completions`,
      });
      expect(resolvePluginProvidersMock).toHaveBeenCalledTimes(inPlace ? 2 : 1);
    },
  );

  it.each([
    { change: "API", normalized: { api: "openai-responses" as const } },
    { change: "base URL", normalized: { baseUrl: "https://api.openai.com/v1/normalized" } },
  ])("applies foreign transport $change normalization for custom hosts", ({ normalized }) => {
    const {
      runtime,
      normalizeDiscoveredAgentModel,
      resolvePluginProvidersMock,
      createDemoProvider,
    } = getContext();
    const model = {
      ...MODEL,
      provider: "custom-openai",
      id: "gpt-5.4",
      api: "openai-completions" as const,
      baseUrl: "https://api.openai.com/v1",
    };
    resolvePluginProvidersMock.mockImplementation((params) => {
      const plugins = [
        createDemoProvider({
          id: "openai",
          normalizeTransport: ({ provider, api, baseUrl }) =>
            provider === model.provider && api === model.api && baseUrl === model.baseUrl
              ? normalized
              : undefined,
        }),
      ];
      return params.onlyPluginIds?.length
        ? plugins.filter((plugin) => params.onlyPluginIds?.includes(plugin.id))
        : plugins;
    });
    expect(
      runtime.applyProviderResolvedTransportWithPlugin({
        provider: model.provider,
        context: {
          provider: model.provider,
          modelId: model.id,
          model,
        },
      }),
    ).toEqual({ ...model, ...normalized });
    expect(normalizeDiscoveredAgentModel(model, "/fixture/agent")).toMatchObject({
      ...model,
      ...normalized,
    });
  });
}
