import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { BUNDLED_WEB_SEARCH_PLUGIN_IDS } from "./bundled-web-search-ids.js";
import { hasBundledWebSearchCredential } from "./bundled-web-search-registry.js";
import {
  listBundledWebSearchProviders,
  resolveBundledWebSearchPluginIds,
} from "./bundled-web-search.js";
import { loadPluginManifestRegistry } from "./manifest-registry.js";

function resolveManifestBundledWebSearchPluginIds() {
  return loadPluginManifestRegistry({})
    .plugins.filter(
      (plugin) =>
        plugin.origin === "bundled" && (plugin.contracts?.webSearchProviders?.length ?? 0) > 0,
    )
    .map((plugin) => plugin.id)
    .toSorted((left, right) => left.localeCompare(right));
}

function resolveRegistryBundledWebSearchPluginIds() {
  return listBundledWebSearchProviders()
    .map(({ pluginId }) => pluginId)
    .filter((value, index, values) => values.indexOf(value) === index)
    .toSorted((left, right) => left.localeCompare(right));
}

function expectBundledWebSearchIds(actual: readonly string[], expected: readonly string[]) {
  expect(actual).toEqual(expected);
}

function expectBundledWebSearchAlignment(params: {
  actual: readonly string[];
  expected: readonly string[];
}) {
  expectBundledWebSearchIds(params.actual, params.expected);
}

describe("bundled web search metadata", () => {
  it.each([
    [
      "keeps bundled web search compat ids aligned with bundled manifests",
      resolveBundledWebSearchPluginIds({}),
      resolveManifestBundledWebSearchPluginIds(),
    ],
    [
      "keeps bundled web search fast-path ids aligned with the registry",
      [...BUNDLED_WEB_SEARCH_PLUGIN_IDS],
      resolveRegistryBundledWebSearchPluginIds(),
    ],
  ] as const)("%s", (_name, actual, expected) => {
    expectBundledWebSearchAlignment({ actual, expected });
  });
});

describe("hasBundledWebSearchCredential", () => {
  const baseCfg = {
    agents: { defaults: { model: { primary: "ollama/mistral-8b" } } },
    browser: { enabled: false },
    tools: { web: { fetch: { enabled: false } } },
  } satisfies OpenClawConfig;

  it.each([
    {
      name: "detects google plugin web search credentials",
      config: {
        ...baseCfg,
        plugins: {
          entries: {
            google: { enabled: true, config: { webSearch: { apiKey: "AIza-test" } } },
          },
        },
      } satisfies OpenClawConfig,
      env: {},
    },
    {
      name: "detects gemini env credentials",
      config: baseCfg,
      env: { GEMINI_API_KEY: "AIza-test" },
    },
    {
      name: "detects xai env credentials",
      config: baseCfg,
      env: { XAI_API_KEY: "xai-test" },
    },
    {
      name: "detects kimi env credentials",
      config: baseCfg,
      env: { KIMI_API_KEY: "sk-kimi-test" },
    },
    {
      name: "detects moonshot env credentials",
      config: baseCfg,
      env: { MOONSHOT_API_KEY: "sk-moonshot-test" },
    },
    {
      name: "detects openrouter env credentials through bundled web search providers",
      config: baseCfg,
      env: { OPENROUTER_API_KEY: "sk-or-v1-test" },
    },
  ] as const)("$name", ({ config, env }) => {
    expect(hasBundledWebSearchCredential({ config, env })).toBe(true);
  });
});
