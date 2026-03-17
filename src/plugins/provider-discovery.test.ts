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

describe("groupPluginDiscoveryProvidersByOrder", () => {
  it("groups providers by declared order and sorts labels within each group", () => {
    const grouped = groupPluginDiscoveryProvidersByOrder([
      makeProvider({ id: "late-b", label: "Zulu" }),
      makeProvider({ id: "late-a", label: "Alpha" }),
      makeProvider({ id: "paired", label: "Paired", order: "paired" }),
      makeProvider({ id: "profile", label: "Profile", order: "profile" }),
      makeProvider({ id: "simple", label: "Simple", order: "simple" }),
    ]);

    expect(grouped.simple.map((provider) => provider.id)).toEqual(["simple"]);
    expect(grouped.profile.map((provider) => provider.id)).toEqual(["profile"]);
    expect(grouped.paired.map((provider) => provider.id)).toEqual(["paired"]);
    expect(grouped.late.map((provider) => provider.id)).toEqual(["late-a", "late-b"]);
  });

  it("uses the legacy discovery hook when catalog is absent", () => {
    const grouped = groupPluginDiscoveryProvidersByOrder([
      makeProvider({ id: "legacy", label: "Legacy", order: "profile", mode: "discovery" }),
    ]);

    expect(grouped.profile.map((provider) => provider.id)).toEqual(["legacy"]);
  });
});

describe("normalizePluginDiscoveryResult", () => {
  it("maps a single provider result to the plugin id", () => {
    const provider = makeProvider({ id: "Ollama" });
    const normalized = normalizePluginDiscoveryResult({
      provider,
      result: {
        provider: makeModelProviderConfig({
          baseUrl: "http://127.0.0.1:11434",
          api: "ollama",
        }),
      },
    });

    expect(normalized).toEqual({
      ollama: {
        baseUrl: "http://127.0.0.1:11434",
        api: "ollama",
        models: [],
      },
    });
  });

  it("normalizes keys for multi-provider discovery results", () => {
    const normalized = normalizePluginDiscoveryResult({
      provider: makeProvider({ id: "ignored" }),
      result: {
        providers: {
          " VLLM ": makeModelProviderConfig(),
          "": makeModelProviderConfig({ baseUrl: "http://ignored" }),
        },
      },
    });

    expect(normalized).toEqual({
      vllm: {
        baseUrl: "http://127.0.0.1:8000/v1",
        models: [],
      },
    });
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
      config: {},
      env: {},
      resolveProviderApiKey: () => ({ apiKey: undefined }),
    });

    expect(result).toEqual({
      provider: {
        baseUrl: "http://catalog.example/v1",
        models: [],
      },
    });
  });
});
