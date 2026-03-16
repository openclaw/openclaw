import { describe, expect, it } from "vitest";
import {
  pluginRegistrationContractRegistry,
  providerContractRegistry,
  webSearchProviderContractRegistry,
} from "./registry.js";

function findProviderIdsForPlugin(pluginId: string) {
  return providerContractRegistry
    .filter((entry) => entry.pluginId === pluginId)
    .map((entry) => entry.provider.id)
    .toSorted((left, right) => left.localeCompare(right));
}

function findWebSearchIdsForPlugin(pluginId: string) {
  return webSearchProviderContractRegistry
    .filter((entry) => entry.pluginId === pluginId)
    .map((entry) => entry.provider.id)
    .toSorted((left, right) => left.localeCompare(right));
}

function findRegistrationForPlugin(pluginId: string) {
  const entry = pluginRegistrationContractRegistry.find(
    (candidate) => candidate.pluginId === pluginId,
  );
  if (!entry) {
    throw new Error(`plugin registration contract missing for ${pluginId}`);
  }
  return entry;
}

describe("plugin contract registry", () => {
  it("does not duplicate bundled provider ids", () => {
    const ids = providerContractRegistry.map((entry) => entry.provider.id);
    expect(ids).toEqual([...new Set(ids)]);
  });

  it("does not duplicate bundled web search provider ids", () => {
    const ids = webSearchProviderContractRegistry.map((entry) => entry.provider.id);
    expect(ids).toEqual([...new Set(ids)]);
  });

  it("keeps multi-provider plugin ownership explicit", () => {
    expect(findProviderIdsForPlugin("google")).toEqual(["google", "google-gemini-cli"]);
    expect(findProviderIdsForPlugin("minimax")).toEqual(["minimax", "minimax-portal"]);
    expect(findProviderIdsForPlugin("openai")).toEqual(["openai", "openai-codex"]);
  });

  it("keeps bundled web search ownership explicit", () => {
    expect(findWebSearchIdsForPlugin("brave")).toEqual(["brave"]);
    expect(findWebSearchIdsForPlugin("firecrawl")).toEqual(["firecrawl"]);
    expect(findWebSearchIdsForPlugin("google")).toEqual(["gemini"]);
    expect(findWebSearchIdsForPlugin("moonshot")).toEqual(["kimi"]);
    expect(findWebSearchIdsForPlugin("perplexity")).toEqual(["perplexity"]);
    expect(findWebSearchIdsForPlugin("xai")).toEqual(["grok"]);
  });

  it("keeps bundled provider and web search tool ownership explicit", () => {
    expect(findRegistrationForPlugin("firecrawl")).toMatchObject({
      providerIds: [],
      webSearchProviderIds: ["firecrawl"],
      toolNames: ["firecrawl_search", "firecrawl_scrape"],
    });
  });
});
