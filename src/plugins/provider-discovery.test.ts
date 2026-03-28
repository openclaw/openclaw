import { describe, expect, it } from "vitest";
import type { ModelProviderConfig } from "../config/types.js";
import {
  groupPluginDiscoveryProvidersByOrder,
  normalizePluginDiscoveryResult,
  runProviderCatalog,
} from "./provider-discovery.js";
import type { ProviderDiscoveryOrder, ProviderPlugin } from "./types.js";

function makeProvider(params: {
  id: string;
  label?: string;
  order?: ProviderDiscoveryOrder;
  mode?: "catalog" | "discovery";
}): ProviderPlugin {
  const hook = {
    ...(params.order ? { order: params.order } : {}),
    run: async () => null,
  };
  return {
    id: params.id,
    label: params.label ?? params.id,
    auth: [],
    ...(params.mode === "discovery" ? { discovery: hook } : { catalog: hook }),
  };
}

function makeModelProviderConfig(overrides?: Partial<ModelProviderConfig>): ModelProviderConfig {
  return {
    baseUrl: "http://127.0.0.1:8000/v1",
    models: [],
    ...overrides,
  };
}

function expectGroupedProviderIds(
  providers: readonly ProviderPlugin[],
  expected: Record<ProviderDiscoveryOrder | "late", readonly string[]>,
) {
  const grouped = groupPluginDiscoveryProvidersByOrder([...providers]);

  expect(grouped.simple.map((provider) => provider.id)).toEqual(expected.simple);
  expect(grouped.profile.map((provider) => provider.id)).toEqual(expected.profile);
  expect(grouped.paired.map((provider) => provider.id)).toEqual(expected.paired);
  expect(grouped.late.map((provider) => provider.id)).toEqual(expected.late);
}

function createCatalogRuntimeContext() {
  return {
    config: {},
    env: {},
    resolveProviderApiKey: () => ({ apiKey: undefined }),
    resolveProviderAuth: () => ({
      apiKey: undefined,
      discoveryApiKey: undefined,
      mode: "none" as const,
      source: "none" as const,
    }),
  };
}

describe("groupPluginDiscoveryProvidersByOrder", () => {
  it.each([
    {
      name: "groups providers by declared order and sorts labels within each group",
      providers: [
        makeProvider({ id: "late-b", label: "Zulu" }),
        makeProvider({ id: "late-a", label: "Alpha" }),
        makeProvider({ id: "paired", label: "Paired", order: "paired" }),
        makeProvider({ id: "profile", label: "Profile", order: "profile" }),
        makeProvider({ id: "simple", label: "Simple", order: "simple" }),
      ],
      expected: {
        simple: ["simple"],
        profile: ["profile"],
        paired: ["paired"],
        late: ["late-a", "late-b"],
      },
    },
    {
      name: "uses the legacy discovery hook when catalog is absent",
      providers: [
        makeProvider({ id: "legacy", label: "Legacy", order: "profile", mode: "discovery" }),
      ],
      expected: {
        simple: [],
        profile: ["legacy"],
        paired: [],
        late: [],
      },
    },
  ] as const)("$name", ({ providers, expected }) => {
    expectGroupedProviderIds(providers, expected);
  });
});

describe("normalizePluginDiscoveryResult", () => {
  it.each([
    {
      name: "maps a single provider result to the plugin id",
      provider: makeProvider({ id: "Ollama" }),
      result: {
        provider: makeModelProviderConfig({
          baseUrl: "http://127.0.0.1:11434",
          api: "ollama",
        }),
      },
      expected: {
        ollama: {
          baseUrl: "http://127.0.0.1:11434",
          api: "ollama",
          models: [],
        },
      },
    },
    {
      name: "normalizes keys for multi-provider discovery results",
      provider: makeProvider({ id: "ignored" }),
      result: {
        providers: {
          " VLLM ": makeModelProviderConfig(),
          "": makeModelProviderConfig({ baseUrl: "http://ignored" }),
        },
      },
      expected: {
        vllm: {
          baseUrl: "http://127.0.0.1:8000/v1",
          models: [],
        },
      },
    },
  ] as const)("$name", ({ provider, result, expected }) => {
    const normalized = normalizePluginDiscoveryResult({ provider, result });
    expect(normalized).toEqual(expected);
  });
});

describe("runProviderCatalog", () => {
  it("prefers catalog over discovery when both exist", async () => {
    const catalogRun = async () => ({
      provider: makeModelProviderConfig({ baseUrl: "http://catalog.example/v1" }),
    });
    const discoveryRun = async () => ({
      provider: makeModelProviderConfig({ baseUrl: "http://discovery.example/v1" }),
    });

    const result = await runProviderCatalog({
      provider: {
        id: "demo",
        label: "Demo",
        auth: [],
        catalog: { run: catalogRun },
        discovery: { run: discoveryRun },
      },
      ...createCatalogRuntimeContext(),
    });

    expect(result).toEqual({
      provider: {
        baseUrl: "http://catalog.example/v1",
        models: [],
      },
    });
  });
});
