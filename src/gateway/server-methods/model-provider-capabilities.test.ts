import path from "node:path";
import { expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { loadPluginManifest } from "../../plugins/manifest.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { resolveModelProviderCapabilities } from "./model-provider-capabilities.js";

it("offers Meta API keys and Muse device sign-in before the Muse runtime is installed or enabled", () => {
  const rootDir = path.resolve("extensions/meta");
  const loaded = loadPluginManifest(rootDir, false);
  if (!loaded.ok) {
    throw new Error(loaded.error);
  }
  const manifest = loaded.manifest;
  const metadataSnapshot = createPluginMetadataSnapshotFixture({
    plugins: [
      {
        id: manifest.id,
        rootDir,
        origin: "bundled",
        providers: manifest.providers,
        providerAuthChoices: manifest.providerAuthChoices,
      },
    ],
  });
  const config: OpenClawConfig = {
    plugins: { entries: { meta: { enabled: true }, muse: { enabled: false } } },
  };
  const { capabilities } = resolveModelProviderCapabilities({
    config,
    metadataSnapshot,
    workspaceDir: path.resolve("workspace-fixture"),
  });

  expect(capabilities.find((entry) => entry.provider === "meta")).toMatchObject({
    provider: "meta",
    apiKeySupported: true,
    quickApiKeySetup: true,
    loginOptions: [
      expect.objectContaining({
        id: "meta/muse-code",
        brandId: "meta",
        label: "Muse Code",
        kind: "device-code",
        requiresSetup: true,
      }),
    ],
  });
});

it("offers llmman a quick API-key setup and leaves the other providers' capabilities unchanged", () => {
  const plugins = ["litellm", "vllm", "lmstudio", "llmman"].map((id) => {
    const rootDir = path.resolve("extensions", id);
    const loaded = loadPluginManifest(rootDir, false);
    if (!loaded.ok) {
      throw new Error(loaded.error);
    }
    return {
      id: loaded.manifest.id,
      rootDir,
      origin: "bundled" as const,
      providers: loaded.manifest.providers,
      providerAuthChoices: loaded.manifest.providerAuthChoices,
    };
  });
  const resolve = (selected: typeof plugins) =>
    resolveModelProviderCapabilities({
      config: {},
      metadataSnapshot: createPluginMetadataSnapshotFixture({ plugins: selected }),
      workspaceDir: path.resolve("workspace-fixture"),
    }).capabilities;

  const withLlmman = resolve(plugins);
  const withoutLlmman = resolve(plugins.filter(({ id }) => id !== "llmman"));

  expect(withLlmman).toContainEqual({
    provider: "llmman",
    apiKeySupported: true,
    quickApiKeySetup: true,
  });
  expect(withLlmman.filter(({ provider }) => provider !== "llmman")).toEqual(withoutLlmman);
  expect(withoutLlmman).toEqual([
    { provider: "litellm", apiKeySupported: true, quickApiKeySetup: true },
    { provider: "lmstudio", apiKeySupported: false, quickApiKeySetup: false },
    { provider: "vllm", apiKeySupported: false, quickApiKeySetup: false },
  ]);
});
