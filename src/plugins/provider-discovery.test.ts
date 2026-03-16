import { describe, expect, it } from "vitest";
import type { ModelProviderConfig } from "../config/types.js";
import {
  groupPluginDiscoveryProvidersByOrder,
  normalizePluginDiscoveryResult,
} from "./provider-discovery.js";
import type { ProviderDiscoveryOrder, ProviderPlugin } from "./types.js";

function makeProvider(params: {
  id: string;
  label?: string;
  order?: ProviderDiscoveryOrder;
}): ProviderPlugin {
  return {
    id: params.id,
    label: params.label ?? params.id,
    auth: [],
    discovery: {
      ...(params.order ? { order: params.order } : {}),
      run: async () => null,
    },
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
