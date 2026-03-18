import { describe, expect, it } from "vitest";
import { loadPluginManifestRegistry } from "../manifest-registry.js";
import { resolvePluginWebSearchProviders } from "../web-search-providers.js";
import {
  capabilityContractLoadError,
  imageGenerationProviderContractRegistry,
  mediaUnderstandingProviderContractRegistry,
  pluginRegistrationContractRegistry,
  providerContractPluginIds,
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

function findImageGenerationProviderIdsForPlugin(pluginId: string) {
  return imageGenerationProviderContractRegistry
    .filter((entry) => entry.pluginId === pluginId)
    .map((entry) => entry.provider.id)
    .toSorted((left, right) => left.localeCompare(right));
}

function findImageGenerationProviderForPlugin(pluginId: string) {
  const entry = imageGenerationProviderContractRegistry.find(
    (candidate) => candidate.pluginId === pluginId,
  );
  if (!entry) {
    throw new Error(`image-generation provider contract missing for ${pluginId}`);
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
  it("loads bundled non-provider capability registries without import-time failure", () => {
    expect(capabilityContractLoadError).toBeUndefined();
    expect(pluginRegistrationContractRegistry.length).toBeGreaterThan(0);
  });

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

  it("covers every bundled provider plugin discovered from manifests", () => {
    const bundledProviderPluginIds = loadPluginManifestRegistry({})
      .plugins.filter((plugin) => plugin.origin === "bundled" && plugin.providers.length > 0)
      .map((plugin) => plugin.id)
      .toSorted((left, right) => left.localeCompare(right));

    expect(providerContractPluginIds).toEqual(bundledProviderPluginIds);
  });

  it("covers every bundled web search plugin from the shared resolver", () => {
    const bundledWebSearchPluginIds = resolvePluginWebSearchProviders({})
      .map((provider) => provider.pluginId)
      .toSorted((left, right) => left.localeCompare(right));

    expect(
      [...new Set(webSearchProviderContractRegistry.map((entry) => entry.pluginId))].toSorted(
        (left, right) => left.localeCompare(right),
      ),
    ).toEqual(bundledWebSearchPluginIds);
  });

  it("does not duplicate bundled image-generation provider ids", () => {
    const ids = imageGenerationProviderContractRegistry.map((entry) => entry.provider.id);
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

  it("keeps bundled image-generation ownership explicit", () => {
    expect(findImageGenerationProviderIdsForPlugin("fal")).toEqual(["fal"]);
    expect(findImageGenerationProviderIdsForPlugin("google")).toEqual(["google"]);
    expect(findImageGenerationProviderIdsForPlugin("openai")).toEqual(["openai"]);
  });

  it("keeps bundled provider and web search tool ownership explicit", () => {
    expect(findRegistrationForPlugin("firecrawl")).toMatchObject({
      providerIds: [],
      speechProviderIds: [],
      mediaUnderstandingProviderIds: [],
      imageGenerationProviderIds: [],
      webSearchProviderIds: ["firecrawl"],
      toolNames: ["firecrawl_search", "firecrawl_scrape"],
    });
  });

  it("tracks speech registrations on bundled provider plugins", () => {
    expect(findRegistrationForPlugin("fal")).toMatchObject({
      providerIds: ["fal"],
      speechProviderIds: [],
      mediaUnderstandingProviderIds: [],
      imageGenerationProviderIds: ["fal"],
      webSearchProviderIds: [],
    });
    expect(findRegistrationForPlugin("google")).toMatchObject({
      providerIds: ["google", "google-gemini-cli"],
      speechProviderIds: [],
      mediaUnderstandingProviderIds: ["google"],
      imageGenerationProviderIds: ["google"],
      webSearchProviderIds: ["gemini"],
    });
    expect(findRegistrationForPlugin("openai")).toMatchObject({
      providerIds: ["openai", "openai-codex"],
      speechProviderIds: ["openai"],
      mediaUnderstandingProviderIds: ["openai"],
      imageGenerationProviderIds: ["openai"],
    });
    expect(findRegistrationForPlugin("elevenlabs")).toMatchObject({
      providerIds: [],
      speechProviderIds: ["elevenlabs"],
      mediaUnderstandingProviderIds: [],
      imageGenerationProviderIds: [],
    });
    expect(findRegistrationForPlugin("microsoft")).toMatchObject({
      providerIds: [],
      speechProviderIds: ["microsoft"],
      mediaUnderstandingProviderIds: [],
      imageGenerationProviderIds: [],
    });
  });

  it("tracks every provider, speech, media, image, or web search plugin in the registration registry", () => {
    const expectedPluginIds = [
      ...new Set([
        ...providerContractRegistry.map((entry) => entry.pluginId),
        ...speechProviderContractRegistry.map((entry) => entry.pluginId),
        ...mediaUnderstandingProviderContractRegistry.map((entry) => entry.pluginId),
        ...imageGenerationProviderContractRegistry.map((entry) => entry.pluginId),
        ...webSearchProviderContractRegistry.map((entry) => entry.pluginId),
      ]),
    ].toSorted((left, right) => left.localeCompare(right));

    expect(
      pluginRegistrationContractRegistry
        .map((entry) => entry.pluginId)
        .toSorted((left, right) => left.localeCompare(right)),
    ).toEqual(expectedPluginIds);
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

  it("keeps bundled image-generation support explicit", () => {
    expect(findImageGenerationProviderForPlugin("google").generateImage).toEqual(
      expect.any(Function),
    );
    expect(findImageGenerationProviderForPlugin("openai").generateImage).toEqual(
      expect.any(Function),
    );
  });
});
