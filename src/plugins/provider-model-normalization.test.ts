import { beforeEach, describe, expect, it, vi } from "vitest";
import { PROVIDER_RUNTIME_TEST_MODEL as MODEL } from "./provider-runtime.test-support.js";
import type {
  ProviderNormalizeResolvedModelContext,
  ProviderNormalizeTransportContext,
  ProviderPlugin,
} from "./types.js";

const fixture = vi.hoisted(() => ({
  select:
    vi.fn<
      (params: {
        providerRefs?: readonly string[];
        modelRefs?: readonly string[];
      }) => ProviderPlugin[]
    >(),
}));
vi.mock("./provider-hook-runtime.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./provider-hook-runtime.js")>();
  const { createProviderHookRuntime } = await import("./provider-hook-runtime-core.js");
  const { nativePluginBindings } = await import("./loader-runtime-load.js");
  const { createEmptyPluginRegistry } = await import("./registry-empty.js");
  return {
    ...original,
    ...createProviderHookRuntime({
      ...nativePluginBindings.providerRegistry,
      resolvePluginProvidersCore: (params) => fixture.select(params),
      resolvePluginProviderRegistryCore: (params) => {
        const plugins = fixture.select(params);
        if (!plugins.length) {
          return undefined;
        }
        const registry = createEmptyPluginRegistry();
        registry.providers = plugins.map((provider) => ({
          pluginId: provider.id,
          provider,
          source: "fixture",
        }));
        return {
          registry,
          workspaceDir: params.workspaceDir,
          onlyPluginIds: undefined,
          isProviderOwnerEligible: () => true,
        };
      },
    }),
  };
});
const { createProviderModelNormalizer } = await import("./provider-model-normalization.js");
const resolvePluginProvidersMock = fixture.select;
function createDemoProvider(overrides: Partial<ProviderPlugin> = {}): ProviderPlugin {
  return { id: "demo", label: "Demo", auth: [], ...overrides };
}
function mockProvider(overrides: Partial<ProviderPlugin>) {
  fixture.select.mockReturnValue([createDemoProvider(overrides)]);
}
function createDemoResolvedModelContext(
  overrides: Partial<ProviderNormalizeResolvedModelContext>,
): ProviderNormalizeResolvedModelContext {
  return {
    provider: "demo",
    modelId: MODEL.id,
    model: MODEL,
    agentDir: "/tmp/catalog-fixture",
    ...overrides,
  };
}
beforeEach(() => {
  fixture.select.mockReset().mockReturnValue([]);
});
describe("catalog model normalization", () => {
  it("selects catalog hooks once per provider while normalizing every model", () => {
    const normalizeResolvedModel = vi.fn(({ model }: ProviderNormalizeResolvedModelContext) => ({
      ...model,
      name: `${model.id} normalized`,
    }));
    const normalizeTransport = vi.fn(() => ({ api: "openai-responses" }));
    mockProvider({ normalizeResolvedModel, normalizeTransport });
    const normalize = createProviderModelNormalizer({});
    for (const id of ["first", "second", "third"]) {
      expect(
        normalize(
          createDemoResolvedModelContext({
            modelId: id,
            model: { ...MODEL, id, api: "openai-completions" },
          }),
        ),
      ).toMatchObject({ id, name: `${id} normalized`, api: "openai-responses" });
    }
    expect(normalizeResolvedModel).toHaveBeenCalledTimes(3);
    expect(normalizeTransport).toHaveBeenCalledTimes(3);
    expect(resolvePluginProvidersMock).toHaveBeenCalledTimes(1);

    mockProvider({ normalizeResolvedModel: ({ model }) => ({ ...model, name: "next catalog" }) });
    expect(createProviderModelNormalizer({})(createDemoResolvedModelContext({})).name).toBe(
      "next catalog",
    );
  });

  it("retries a missing catalog owner for a different model", () => {
    resolvePluginProvidersMock.mockImplementation((params) =>
      params.modelRefs?.includes("demo/second")
        ? [
            createDemoProvider({
              normalizeResolvedModel: ({ model }) => ({ ...model, name: "found" }),
            }),
          ]
        : [],
    );
    const normalize = createProviderModelNormalizer({});
    expect(
      normalize(
        createDemoResolvedModelContext({ modelId: "first", model: { ...MODEL, id: "first" } }),
      ).name,
    ).toBe(MODEL.name);
    expect(
      normalize(
        createDemoResolvedModelContext({ modelId: "second", model: { ...MODEL, id: "second" } }),
      ).name,
    ).toBe("found");
  });

  it("keeps transport fallback ordering and origin checks across a catalog batch", () => {
    const crossOrigin = vi.fn(() => ({ baseUrl: "https://other.example.test/v1" }));
    const sameOrigin = vi.fn(({ baseUrl }: ProviderNormalizeTransportContext) => ({
      baseUrl: `${baseUrl}/normalized`,
    }));
    resolvePluginProvidersMock.mockReturnValue([
      createDemoProvider(),
      { id: "other", label: "Other", auth: [], normalizeTransport: crossOrigin },
      { id: "family", label: "Family", auth: [], normalizeTransport: sameOrigin },
    ]);
    const normalize = createProviderModelNormalizer({});
    for (const id of ["first", "second"]) {
      expect(
        normalize(
          createDemoResolvedModelContext({
            modelId: id,
            model: { ...MODEL, id, baseUrl: "https://example.test/v1" },
          }),
        ).baseUrl,
      ).toBe("https://example.test/v1/normalized");
    }
    expect(crossOrigin).toHaveBeenCalledTimes(2);
    expect(sameOrigin).toHaveBeenCalledTimes(2);
    expect(resolvePluginProvidersMock).toHaveBeenCalledTimes(2);
  });

  it("uses a model's mutated provider and id for transport normalization", () => {
    const transport = vi.fn(() => ({ api: "openai-responses" }));
    resolvePluginProvidersMock.mockReturnValue([
      createDemoProvider({
        normalizeResolvedModel: ({ model }) => {
          model.provider = "other";
          model.id = "renamed";
          return model;
        },
      }),
      { id: "other", label: "Other", auth: [], normalizeTransport: transport },
    ]);
    const model = createProviderModelNormalizer({})(
      createDemoResolvedModelContext({
        model: { ...MODEL, api: "openai-completions" },
      }),
    );
    expect(model).toMatchObject({ provider: "other", id: "renamed", api: "openai-responses" });
    expect(transport).toHaveBeenCalledOnce();
    expect(transport).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "other",
        modelId: "renamed",
      }),
    );
  });
});
