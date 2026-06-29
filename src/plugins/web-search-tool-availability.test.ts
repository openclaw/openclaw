import { describe, expect, it } from "vitest";
import type { PluginWebSearchProviderEntry } from "./types.js";
import { checkWebSearchAvailability } from "./web-search-tool-availability.js";

function makeProvider(id: string): PluginWebSearchProviderEntry {
  return {
    id,
    label: id,
    pluginId: `plugin-${id}`,
    contracts: ["webSearchProviders"],
  } as PluginWebSearchProviderEntry;
}

describe("checkWebSearchAvailability", () => {
  it("returns undefined when toolsAllow is undefined", () => {
    expect(checkWebSearchAvailability({ toolsAllow: undefined, providers: [] })).toBeUndefined();
  });

  it("returns undefined when toolsAllow is null", () => {
    expect(checkWebSearchAvailability({ toolsAllow: null, providers: [] })).toBeUndefined();
  });

  it("returns undefined when toolsAllow does not contain web_search", () => {
    expect(
      checkWebSearchAvailability({
        toolsAllow: ["exec", "read", "write"],
        providers: [],
      }),
    ).toBeUndefined();
  });

  it("returns undefined when toolsAllow is empty", () => {
    expect(checkWebSearchAvailability({ toolsAllow: [], providers: [] })).toBeUndefined();
  });

  it("returns undefined when web_search is in toolsAllow and providers are available", () => {
    expect(
      checkWebSearchAvailability({
        toolsAllow: ["web_search"],
        providers: [makeProvider("duckduckgo")],
      }),
    ).toBeUndefined();
  });

  it("returns undefined when web_search is in toolsAllow with multiple providers", () => {
    expect(
      checkWebSearchAvailability({
        toolsAllow: ["web_search", "web_fetch"],
        providers: [makeProvider("duckduckgo"), makeProvider("tavily")],
      }),
    ).toBeUndefined();
  });

  it("returns warning when web_search is in toolsAllow but no providers are available", () => {
    const result = checkWebSearchAvailability({
      toolsAllow: ["web_search"],
      providers: [],
    });
    expect(result).toBeDefined();
    expect(result!.warning).toContain("web_search is in toolsAllow");
    expect(result!.warning).toContain("openclaw plugins enable duckduckgo");
  });

  it("returns warning when toolsAllow includes web_search among other tools and no providers", () => {
    const result = checkWebSearchAvailability({
      toolsAllow: ["read", "web_search", "exec"],
      providers: [],
    });
    expect(result).toBeDefined();
    expect(result!.warning).toContain("web_search is in toolsAllow");
  });

  it("returns warning when toolsAllow has only web_search and no providers", () => {
    const result = checkWebSearchAvailability({
      toolsAllow: ["web_search"],
      providers: [],
    });
    expect(result).toBeDefined();
    expect(result!.warning).toContain("no web search provider plugin is enabled");
  });

  it("handles case-sensitive match correctly", () => {
    // toolsAllow is expected to use the exact tool name
    const result = checkWebSearchAvailability({
      toolsAllow: ["web_search"],
      providers: [],
    });
    expect(result).toBeDefined();
  });
});
