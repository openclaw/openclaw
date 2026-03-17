import { describe, expect, it } from "vitest";
import {
  mediaUnderstandingProviderContractRegistry,
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

function findMediaUnderstandingProviderIdsForPlugin(pluginId: string) {
  return mediaUnderstandingProviderContractRegistry
    .filter((entry) => entry.pluginId === pluginId)
    .map((entry) => entry.provider.id)
    .toSorted((left, right) => left.localeCompare(right));
}

function findMediaUnderstandingProviderForPlugin(pluginId: string) {
  const entry = mediaUnderstandingProviderContractRegistry.find(
    (candidate) => candidate.pluginId === pluginId,
  );
  if (!entry) {
    throw new Error(`media-understanding provider contract missing for ${pluginId}`);
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

  it("does not duplicate bundled media provider ids", () => {
    const ids = mediaUnderstandingProviderContractRegistry.map((entry) => entry.provider.id);
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

  it("keeps bundled media-understanding ownership explicit", () => {
    expect(findMediaUnderstandingProviderIdsForPlugin("anthropic")).toEqual(["anthropic"]);
    expect(findMediaUnderstandingProviderIdsForPlugin("google")).toEqual(["google"]);
    expect(findMediaUnderstandingProviderIdsForPlugin("minimax")).toEqual([
      "minimax",
      "minimax-portal",
    ]);
    expect(findMediaUnderstandingProviderIdsForPlugin("mistral")).toEqual(["mistral"]);
    expect(findMediaUnderstandingProviderIdsForPlugin("moonshot")).toEqual(["moonshot"]);
    expect(findMediaUnderstandingProviderIdsForPlugin("openai")).toEqual(["openai"]);
    expect(findMediaUnderstandingProviderIdsForPlugin("zai")).toEqual(["zai"]);
  });

  it("keeps bundled provider and web search tool ownership explicit", () => {
    expect(findRegistrationForPlugin("firecrawl")).toMatchObject({
      providerIds: [],
      speechProviderIds: [],
      mediaUnderstandingProviderIds: [],
      webSearchProviderIds: ["firecrawl"],
      toolNames: ["firecrawl_search", "firecrawl_scrape"],
    });
  });

  it("tracks speech registrations on bundled provider plugins", () => {
    expect(findRegistrationForPlugin("openai")).toMatchObject({
      providerIds: ["openai", "openai-codex"],
      speechProviderIds: ["openai"],
      mediaUnderstandingProviderIds: ["openai"],
    });
    expect(findRegistrationForPlugin("elevenlabs")).toMatchObject({
      providerIds: [],
      speechProviderIds: ["elevenlabs"],
      mediaUnderstandingProviderIds: [],
    });
    expect(findRegistrationForPlugin("microsoft")).toMatchObject({
      providerIds: [],
      speechProviderIds: ["microsoft"],
      mediaUnderstandingProviderIds: [],
    });
  });

  it("keeps bundled speech voice-list support explicit", () => {
    expect(findSpeechProviderForPlugin("openai").listVoices).toEqual(expect.any(Function));
    expect(findSpeechProviderForPlugin("elevenlabs").listVoices).toEqual(expect.any(Function));
    expect(findSpeechProviderForPlugin("microsoft").listVoices).toEqual(expect.any(Function));
  });

  it("keeps bundled multi-image support explicit", () => {
    expect(findMediaUnderstandingProviderForPlugin("anthropic").describeImages).toEqual(
      expect.any(Function),
    );
    expect(findMediaUnderstandingProviderForPlugin("google").describeImages).toEqual(
      expect.any(Function),
    );
    expect(findMediaUnderstandingProviderForPlugin("minimax").describeImages).toEqual(
      expect.any(Function),
    );
    expect(findMediaUnderstandingProviderForPlugin("moonshot").describeImages).toEqual(
      expect.any(Function),
    );
    expect(findMediaUnderstandingProviderForPlugin("openai").describeImages).toEqual(
      expect.any(Function),
    );
    expect(findMediaUnderstandingProviderForPlugin("zai").describeImages).toEqual(
      expect.any(Function),
    );
  });
});
