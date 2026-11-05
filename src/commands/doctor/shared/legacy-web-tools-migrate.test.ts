import { expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import {
  listLegacyWebSearchConfigPaths,
  migrateLegacyWebFetchConfig,
  migrateLegacyWebSearchConfig,
  migrateLegacyXSearchConfig,
} from "./legacy-web-tools-migrate.js";

const searchConfig = <T>(value: T) => ({ tools: { web: { search: value } } });
const pluginSearch = (webSearch: Record<string, unknown>) => ({
  enabled: true,
  config: { webSearch },
});
function search(value: Record<string, unknown>, plugins?: OpenClawConfig["plugins"]) {
  return migrateLegacyWebSearchConfig({ ...searchConfig(value), plugins });
}

it("moves provider-owned config, retaining unknown fields but not dangerous keys", () => {
  const input = searchConfig({
    provider: "grok",
    apiKey: "test-key",
    grok: { apiKey: "test-secret", model: "grok-4-1-fast" },
    kimi: { apiKey: "sample", model: "kimi-k2.5" },
    customSearch: { endpoint: "https://search.example.test" },
    ["__proto__"]: { polluted: true },
    constructor: { polluted: true },
    prototype: { polluted: true },
  });
  const result = migrateLegacyWebSearchConfig(input);
  expect(result.config.tools.web.search).toEqual({
    provider: "grok",
    customSearch: { endpoint: "https://search.example.test" },
  });
  expect(result.config).toHaveProperty("plugins.entries", {
    brave: pluginSearch({ apiKey: "test-key" }),
    xai: pluginSearch({ apiKey: "test-secret", model: "grok-4-1-fast" }),
    moonshot: pluginSearch({ apiKey: "sample", model: "kimi-k2.5" }),
  });
  expect(listLegacyWebSearchConfigPaths(input)).toEqual([
    "tools.web.search.apiKey",
    "tools.web.search.grok.apiKey",
    "tools.web.search.grok.model",
    "tools.web.search.kimi.apiKey",
    "tools.web.search.kimi.model",
  ]);
});

it("gives global auth precedence while recursively preserving plugin config", () => {
  const result = search(
    {
      apiKey: "example",
      brave: { apiKey: "test-key", nested: { fromLegacy: true, shared: "legacy" } },
    },
    { entries: { brave: pluginSearch({ nested: { shared: "plugin" } }) } },
  );
  expect(result.config.plugins?.entries?.brave?.config?.webSearch).toEqual({
    apiKey: "example",
    nested: { fromLegacy: true, shared: "plugin" },
  });
});

it("strips empty search records without mutating input or inventing a change", () => {
  const input = searchConfig({ provider: "grok", grok: {} });
  expect(migrateLegacyWebSearchConfig(input)).toStrictEqual({
    config: searchConfig({ provider: "grok" }),
    changes: [],
  });
  expect(input.tools.web.search).toEqual({ provider: "grok", grok: {} });
});

it.each([false, true])(
  "removes the Firecrawl switch and migrates its payload (empty=%s)",
  (empty) => {
    const firecrawl = empty
      ? { enabled: false }
      : { enabled: false, apiKey: "dummy", onlyMainContent: false };
    const result = migrateLegacyWebFetchConfig({
      tools: { web: { fetch: { timeoutSeconds: 15, firecrawl } } },
    });
    expect(result.config.tools.web.fetch).toEqual({ timeoutSeconds: 15 });
    if (empty) {
      expect(result.config).not.toHaveProperty("plugins");
    } else {
      expect(result.config).toHaveProperty("plugins.entries.firecrawl", {
        enabled: true,
        config: { webFetch: { apiKey: "dummy", onlyMainContent: false } },
      });
    }
  },
);

it.each([
  [{ model: "grok-3" }, undefined, { x_search: { model: "grok-3" } }],
  [{}, undefined, {}],
  [{ cacheTtlMinutes: 5 }, "test-token", { x_search: { cacheTtlMinutes: 5 } }],
] as const)("moves X auth without replacing plugin auth: %j, %s", (rest, existing, web) => {
  const result = migrateLegacyXSearchConfig({
    tools: { web: { x_search: { apiKey: "placeholder", ...rest } } },
    plugins: existing ? { entries: { xai: pluginSearch({ apiKey: existing }) } } : undefined,
  });
  expect(result.config.tools.web).toEqual(web);
  expect(result.config).toHaveProperty(
    "plugins.entries.xai.config.webSearch.apiKey",
    existing ?? "placeholder",
  );
});

it("preserves model-only selections without creating plugin config", () => {
  const input = { tools: { web: { x_search: { enabled: true, model: "grok-code-fast-1" } } } };
  expect(migrateLegacyXSearchConfig(input)).toEqual({ config: input, changes: [] });
});
