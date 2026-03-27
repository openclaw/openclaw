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

const REGISTRY_CONTRACT_TIMEOUT_MS = 300_000;

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

  it(
    "does not duplicate bundled speech provider ids",
    { timeout: REGISTRY_CONTRACT_TIMEOUT_MS },
    () => {
      const ids = speechProviderContractRegistry.map((entry) => entry.provider.id);
      expect(ids).toEqual([...new Set(ids)]);
    },
  );

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
    const bundledSpeechPluginIds = loadPluginManifestRegistry({})
      .plugins.filter(
        (plugin) =>
          plugin.origin === "bundled" && (plugin.contracts?.speechProviders?.length ?? 0) > 0,
      )
      .map((plugin) => plugin.id)
      .toSorted((left, right) => left.localeCompare(right));

    expect(
      [...new Set(speechProviderContractRegistry.map((entry) => entry.pluginId))].toSorted(
        (left, right) => left.localeCompare(right),
      ),
    ).toEqual(bundledSpeechPluginIds);
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

  it("does not duplicate bundled image-generation provider ids", () => {
    const ids = imageGenerationProviderContractRegistry.map((entry) => entry.provider.id);
    expect(ids).toEqual([...new Set(ids)]);
  });
});
