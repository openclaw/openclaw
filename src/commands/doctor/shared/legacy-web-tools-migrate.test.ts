import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import {
  listLegacyWebSearchConfigPaths,
  migrateLegacyWebFetchConfig,
  migrateLegacyWebSearchConfig,
  migrateLegacyXSearchConfig,
} from "./legacy-web-tools-migrate.js";

const searchConfig = <T>(value: T) => ({ tools: { web: { search: value } } });

function search(value: Record<string, unknown>, plugins?: OpenClawConfig["plugins"]) {
  return migrateLegacyWebSearchConfig({ ...searchConfig(value), plugins });
}

const pluginSearch = (webSearch: Record<string, unknown>) => ({
  enabled: true,
  config: { webSearch },
});
const movedXAuth = "Moved tools.web.x_search.apiKey → plugins.entries.xai.config.webSearch.apiKey.";
const xSearch = (x_search: Record<string, unknown>) =>
  migrateLegacyXSearchConfig({ tools: { web: { x_search } } });

describe("legacy web tool config", () => {
  it("migrates provider config in deterministic owner order", () => {
    const result = search({
      provider: "grok",
      apiKey: "test-key",
      grok: { apiKey: "test-secret", model: "grok-4-1-fast" },
      kimi: { apiKey: "sample", model: "kimi-k2.5" },
    });

    expect(result.config.tools?.web?.search).toEqual({ provider: "grok" });
    expect(result.config.plugins?.entries).toEqual({
      brave: pluginSearch({ apiKey: "test-key" }),
      xai: pluginSearch({ apiKey: "test-secret", model: "grok-4.3" }),
      moonshot: pluginSearch({ apiKey: "sample", model: "kimi-k2.5" }),
    });
    expect(result.changes).toEqual([
      "Moved tools.web.search.apiKey → plugins.entries.brave.config.webSearch.apiKey.",
      'Updated tools.web.search.grok.model from "grok-4-1-fast" to "grok-4.3".',
      "Moved tools.web.search.grok → plugins.entries.xai.config.webSearch.",
      "Moved tools.web.search.kimi → plugins.entries.moonshot.config.webSearch.",
    ]);
  });

  it("gives global auth precedence over Brave source while recursively preserving plugin config", () => {
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
    expect(result.changes).toEqual([
      "Merged tools.web.search.apiKey → plugins.entries.brave.config.webSearch (filled missing fields from legacy; kept explicit plugin config values).",
    ]);
  });

  it("strips empty mapped records without mutating the input or inventing a change", () => {
    const input = searchConfig({ provider: "grok", grok: {} });
    const result = migrateLegacyWebSearchConfig(input);

    expect(result.config).not.toBe(input);
    expect(result).toStrictEqual({ config: searchConfig({ provider: "grok" }), changes: [] });
    expect(input.tools.web.search).toEqual({ provider: "grok", grok: {} });
  });

  it("preserves unknown fields, drops dangerous keys, and lists mapped paths", () => {
    const input = searchConfig({
      apiKey: "test-key",
      grok: { apiKey: "test-secret", model: "grok-latest" },
      customSearch: { endpoint: "https://search.example.test" },
      ["__proto__"]: { polluted: true },
      constructor: { polluted: true },
      prototype: { polluted: true },
    });

    expect(listLegacyWebSearchConfigPaths(input)).toEqual([
      "tools.web.search.apiKey",
      "tools.web.search.grok.apiKey",
      "tools.web.search.grok.model",
    ]);
    expect(migrateLegacyWebSearchConfig(input).config.tools.web.search).toEqual({
      customSearch: { endpoint: "https://search.example.test" },
    });
  });
  it("moves Firecrawl config, discards enabled, and preserves other fetch knobs", () => {
    const fetch = {
      provider: "firecrawl",
      timeoutSeconds: 15,
      firecrawl: { enabled: false, apiKey: "dummy", onlyMainContent: false },
    };
    const result = migrateLegacyWebFetchConfig({ tools: { web: { fetch } } });

    expect(result.config.tools?.web?.fetch).toEqual({ provider: "firecrawl", timeoutSeconds: 15 });
    expect(result.config).toHaveProperty("plugins.entries.firecrawl", {
      enabled: true,
      config: { webFetch: { apiKey: "dummy", onlyMainContent: false } },
    });
    expect(result.changes).toEqual([
      "Moved tools.web.fetch.firecrawl → plugins.entries.firecrawl.config.webFetch.",
    ]);
  });

  it("removes an empty Firecrawl payload without creating plugin config", () => {
    const fetch = { firecrawl: { enabled: false }, timeoutSeconds: 10 };
    expect(migrateLegacyWebFetchConfig({ tools: { web: { fetch } } })).toStrictEqual({
      config: { tools: { web: { fetch: { timeoutSeconds: 10 } } } },
      changes: ["Removed empty tools.web.fetch.firecrawl."],
    });
  });
  it("keeps explicit plugin-owned auth", () => {
    const webSearch = { apiKey: "test-token" };
    const result = migrateLegacyXSearchConfig({
      tools: { web: { x_search: { apiKey: "placeholder", cacheTtlMinutes: 5 } } },
      plugins: { entries: { xai: pluginSearch(webSearch) } },
    });

    expect(result.config.plugins.entries.xai.config.webSearch).toEqual(webSearch);
    expect(result.config.tools.web.x_search).toEqual({ cacheTtlMinutes: 5 });
    expect(result.changes).toEqual([
      "Removed tools.web.x_search.apiKey (plugins.entries.xai.config.webSearch.apiKey already set).",
    ]);
  });

  it.each([
    [
      "repairs models before moving auth",
      { apiKey: "placeholder", model: "grok-3" },
      { x_search: { model: "grok-4.3" } },
      ['Updated tools.web.x_search.model from "grok-3" to "grok-4.3".', movedXAuth],
    ],
    [
      "removes an emptied source",
      { apiKey: "placeholder" },
      {},
      [movedXAuth, "Removed empty tools.web.x_search."],
    ],
  ] as const)("%s", (_name, input, web, changes) => {
    const result = xSearch(input);
    expect(result.config.tools.web).toEqual(web);
    expect(result.changes).toEqual(changes);
  });

  it("repairs retired model-only aliases without creating plugin config", () => {
    const retired = xSearch({ enabled: true, model: "grok-code-fast-1" });
    expect(retired.config.tools.web.x_search).toEqual({ enabled: true, model: "grok-build-0.1" });
    expect(retired.config).not.toHaveProperty("plugins");
    expect(xSearch({ model: "grok-latest" }).changes).toStrictEqual([]);
  });
});
