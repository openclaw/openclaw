import { describe, expect, it } from "vitest";
import {
  pluginRegistrationContractRegistry,
  providerContractRegistry,
  speechProviderContractRegistry,
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

function findSpeechProviderIdsForPlugin(pluginId: string) {
  return speechProviderContractRegistry
    .filter((entry) => entry.pluginId === pluginId)
    .map((entry) => entry.provider.id)
    .toSorted((left, right) => left.localeCompare(right));
}

function findSpeechProviderForPlugin(pluginId: string) {
  const entry = speechProviderContractRegistry.find((candidate) => candidate.pluginId === pluginId);
  if (!entry) {
    throw new Error(`speech provider contract missing for ${pluginId}`);
  }
  return entry.provider;
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

  it("does not duplicate bundled speech provider ids", () => {
    const ids = speechProviderContractRegistry.map((entry) => entry.provider.id);
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

  it("keeps bundled speech ownership explicit", () => {
    expect(findSpeechProviderIdsForPlugin("elevenlabs")).toEqual(["elevenlabs"]);
    expect(findSpeechProviderIdsForPlugin("microsoft")).toEqual(["microsoft"]);
    expect(findSpeechProviderIdsForPlugin("openai")).toEqual(["openai"]);
  });

  it("keeps bundled provider and web search tool ownership explicit", () => {
    expect(findRegistrationForPlugin("firecrawl")).toMatchObject({
      providerIds: [],
      speechProviderIds: [],
      webSearchProviderIds: ["firecrawl"],
      toolNames: ["firecrawl_search", "firecrawl_scrape"],
    });
  });

  it("tracks speech registrations on bundled provider plugins", () => {
    expect(findRegistrationForPlugin("openai")).toMatchObject({
      providerIds: ["openai", "openai-codex"],
      speechProviderIds: ["openai"],
    });
    expect(findRegistrationForPlugin("elevenlabs")).toMatchObject({
      providerIds: [],
      speechProviderIds: ["elevenlabs"],
    });
    expect(findRegistrationForPlugin("microsoft")).toMatchObject({
      providerIds: [],
      speechProviderIds: ["microsoft"],
    });
  });

  it("keeps bundled speech voice-list support explicit", () => {
    expect(findSpeechProviderForPlugin("openai").listVoices).toEqual(expect.any(Function));
    expect(findSpeechProviderForPlugin("elevenlabs").listVoices).toEqual(expect.any(Function));
    expect(findSpeechProviderForPlugin("microsoft").listVoices).toEqual(expect.any(Function));
  });
});
