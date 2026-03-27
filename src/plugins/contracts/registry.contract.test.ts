import { describe, expect, it } from "vitest";
import { resolveBundledWebSearchPluginIds } from "../bundled-web-search.js";
import { loadPluginManifestRegistry } from "../manifest-registry.js";
import {
  imageGenerationProviderContractRegistry,
  mediaUnderstandingProviderContractRegistry,
  pluginRegistrationContractRegistry,
  providerContractLoadError,
  providerContractPluginIds,
  speechProviderContractRegistry,
} from "./registry.js";

function findProviderIdsForPlugin(pluginId: string) {
  return (
    pluginRegistrationContractRegistry.find((entry) => entry.pluginId === pluginId)?.providerIds ??
    []
  );
}

function findWebSearchIdsForPlugin(pluginId: string) {
  return (
    pluginRegistrationContractRegistry.find((entry) => entry.pluginId === pluginId)
      ?.webSearchProviderIds ?? []
  );
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

type BundledCapabilityContractKey =
  | "speechProviders"
  | "mediaUnderstandingProviders"
  | "imageGenerationProviders";

function findBundledManifestPluginIdsForContract(key: BundledCapabilityContractKey) {
  return loadPluginManifestRegistry({})
    .plugins.filter(
      (plugin) => plugin.origin === "bundled" && (plugin.contracts?.[key]?.length ?? 0) > 0,
    )
    .map((plugin) => plugin.id)
    .toSorted((left, right) => left.localeCompare(right));
}

describe("plugin contract registry", () => {
  it("loads bundled non-provider capability registries without import-time failure", () => {
    expect(providerContractLoadError).toBeUndefined();
    expect(pluginRegistrationContractRegistry.length).toBeGreaterThan(0);
  });

  it("does not duplicate bundled provider ids", () => {
    const ids = pluginRegistrationContractRegistry.flatMap((entry) => entry.providerIds);
    expect(ids).toEqual([...new Set(ids)]);
  });

  it("does not duplicate bundled web search provider ids", () => {
    const ids = pluginRegistrationContractRegistry.flatMap((entry) => entry.webSearchProviderIds);
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

  it("covers every bundled speech plugin discovered from manifests", () => {
    const bundledSpeechPluginIds = findBundledManifestPluginIdsForContract("speechProviders");

    expect(
      [...new Set(speechProviderContractRegistry.map((entry) => entry.pluginId))].toSorted(
        (left, right) => left.localeCompare(right),
      ),
    ).toEqual(bundledSpeechPluginIds);
  });

  it("covers every bundled media-understanding plugin discovered from manifests", () => {
    const bundledMediaPluginIds = findBundledManifestPluginIdsForContract(
      "mediaUnderstandingProviders",
    );

    expect(
      [
        ...new Set(mediaUnderstandingProviderContractRegistry.map((entry) => entry.pluginId)),
      ].toSorted((left, right) => left.localeCompare(right)),
    ).toEqual(bundledMediaPluginIds);
  });

  it("covers every bundled image-generation plugin discovered from manifests", () => {
    const bundledImagePluginIds = findBundledManifestPluginIdsForContract(
      "imageGenerationProviders",
    );

    expect(
      [...new Set(imageGenerationProviderContractRegistry.map((entry) => entry.pluginId))].toSorted(
        (left, right) => left.localeCompare(right),
      ),
    ).toEqual(bundledImagePluginIds);
  });

  it("keeps bundled legacy capability fields aligned with manifest contracts", () => {
    for (const plugin of loadPluginManifestRegistry({}).plugins.filter(
      (candidate) => candidate.origin === "bundled",
    )) {
      expect(plugin.speechProviders).toEqual(plugin.contracts?.speechProviders ?? []);
      expect(plugin.mediaUnderstandingProviders).toEqual(
        plugin.contracts?.mediaUnderstandingProviders ?? [],
      );
      expect(plugin.imageGenerationProviders).toEqual(
        plugin.contracts?.imageGenerationProviders ?? [],
      );
    }
  });

  it("covers every bundled web search plugin from the shared resolver", () => {
    const bundledWebSearchPluginIds = resolveBundledWebSearchPluginIds({});

    expect(
      pluginRegistrationContractRegistry
        .filter((entry) => entry.webSearchProviderIds.length > 0)
        .map((entry) => entry.pluginId)
        .toSorted((left, right) => left.localeCompare(right)),
    ).toEqual(bundledWebSearchPluginIds);
  });

  it("keeps Kimi Coding onboarding grouped under Moonshot", () => {
    const kimi = loadPluginManifestRegistry({}).plugins.find(
      (plugin) => plugin.origin === "bundled" && plugin.id === "kimi",
    );

    expect(kimi?.providerAuthChoices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          choiceId: "kimi-code-api-key",
          choiceLabel: "Kimi Code API key (subscription)",
          groupId: "moonshot",
          groupLabel: "Moonshot AI (Kimi K2.5)",
          groupHint: "Kimi K2.5",
        }),
      ]),
    );
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
    expect(findWebSearchIdsForPlugin("duckduckgo")).toEqual(["duckduckgo"]);
    expect(findWebSearchIdsForPlugin("exa")).toEqual(["exa"]);
    expect(findWebSearchIdsForPlugin("firecrawl")).toEqual(["firecrawl"]);
    expect(findWebSearchIdsForPlugin("google")).toEqual(["gemini"]);
    expect(findWebSearchIdsForPlugin("moonshot")).toEqual(["kimi"]);
    expect(findWebSearchIdsForPlugin("perplexity")).toEqual(["perplexity"]);
    expect(findWebSearchIdsForPlugin("tavily")).toEqual(["tavily"]);
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
    expect(findMediaUnderstandingProviderIdsForPlugin("openai")).toEqual([
      "openai",
      "openai-codex",
    ]);
    expect(findMediaUnderstandingProviderIdsForPlugin("zai")).toEqual(["zai"]);
  });

  it("keeps bundled image-generation ownership explicit", () => {
    expect(findImageGenerationProviderIdsForPlugin("fal")).toEqual(["fal"]);
    expect(findImageGenerationProviderIdsForPlugin("google")).toEqual(["google"]);
    expect(findImageGenerationProviderIdsForPlugin("minimax")).toEqual([
      "minimax",
      "minimax-portal",
    ]);
    expect(findImageGenerationProviderIdsForPlugin("openai")).toEqual(["openai"]);
  });

  it("keeps bundled provider and web search tool ownership explicit", () => {
    expect(findRegistrationForPlugin("exa")).toMatchObject({
      cliBackendIds: [],
      providerIds: [],
      speechProviderIds: [],
      mediaUnderstandingProviderIds: [],
      imageGenerationProviderIds: [],
      webSearchProviderIds: ["exa"],
      toolNames: [],
    });
    expect(findRegistrationForPlugin("firecrawl")).toMatchObject({
      cliBackendIds: [],
      providerIds: [],
      speechProviderIds: [],
      mediaUnderstandingProviderIds: [],
      imageGenerationProviderIds: [],
      webSearchProviderIds: ["firecrawl"],
      toolNames: ["firecrawl_search", "firecrawl_scrape"],
    });
    expect(findRegistrationForPlugin("tavily")).toMatchObject({
      cliBackendIds: [],
      providerIds: [],
      speechProviderIds: [],
      mediaUnderstandingProviderIds: [],
      imageGenerationProviderIds: [],
      webSearchProviderIds: ["tavily"],
      toolNames: ["tavily_search", "tavily_extract"],
    });
  });

  it("tracks speech registrations on bundled provider plugins", () => {
    expect(findRegistrationForPlugin("fal")).toMatchObject({
      cliBackendIds: [],
      providerIds: ["fal"],
      speechProviderIds: [],
      mediaUnderstandingProviderIds: [],
      imageGenerationProviderIds: ["fal"],
      webSearchProviderIds: [],
    });
    expect(findRegistrationForPlugin("anthropic")).toMatchObject({
      cliBackendIds: ["claude-cli"],
      providerIds: ["anthropic"],
      speechProviderIds: [],
      mediaUnderstandingProviderIds: ["anthropic"],
      imageGenerationProviderIds: [],
      webSearchProviderIds: [],
    });
    expect(findRegistrationForPlugin("google")).toMatchObject({
      cliBackendIds: ["google-gemini-cli"],
      providerIds: ["google", "google-gemini-cli"],
      speechProviderIds: [],
      mediaUnderstandingProviderIds: ["google"],
      imageGenerationProviderIds: ["google"],
      webSearchProviderIds: ["gemini"],
    });
    expect(findRegistrationForPlugin("openai")).toMatchObject({
      cliBackendIds: ["codex-cli"],
      providerIds: ["openai", "openai-codex"],
      speechProviderIds: ["openai"],
      mediaUnderstandingProviderIds: ["openai", "openai-codex"],
      imageGenerationProviderIds: ["openai"],
    });
    expect(findRegistrationForPlugin("minimax")).toMatchObject({
      cliBackendIds: [],
      providerIds: ["minimax", "minimax-portal"],
      speechProviderIds: [],
      mediaUnderstandingProviderIds: ["minimax", "minimax-portal"],
      imageGenerationProviderIds: ["minimax", "minimax-portal"],
      webSearchProviderIds: [],
    });
    expect(findRegistrationForPlugin("elevenlabs")).toMatchObject({
      cliBackendIds: [],
      providerIds: [],
      speechProviderIds: ["elevenlabs"],
      mediaUnderstandingProviderIds: [],
      imageGenerationProviderIds: [],
    });
    expect(findRegistrationForPlugin("microsoft")).toMatchObject({
      cliBackendIds: [],
      providerIds: [],
      speechProviderIds: ["microsoft"],
      mediaUnderstandingProviderIds: [],
      imageGenerationProviderIds: [],
    });
  });

  it("tracks every provider, speech, media, image, or web search plugin in the registration registry", () => {
    const expectedPluginIds = [
      ...new Set([
        ...pluginRegistrationContractRegistry
          .filter((entry) => entry.providerIds.length > 0)
          .map((entry) => entry.pluginId),
        ...speechProviderContractRegistry.map((entry) => entry.pluginId),
        ...mediaUnderstandingProviderContractRegistry.map((entry) => entry.pluginId),
        ...imageGenerationProviderContractRegistry.map((entry) => entry.pluginId),
        ...pluginRegistrationContractRegistry
          .filter((entry) => entry.webSearchProviderIds.length > 0)
          .map((entry) => entry.pluginId),
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
    expect(findImageGenerationProviderForPlugin("minimax").generateImage).toEqual(
      expect.any(Function),
    );
    expect(findImageGenerationProviderForPlugin("openai").generateImage).toEqual(
      expect.any(Function),
    );
  });
});
