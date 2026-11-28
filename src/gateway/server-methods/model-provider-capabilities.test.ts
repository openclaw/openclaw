import path from "node:path";
import { expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { loadPluginManifest } from "../../plugins/manifest.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { resolveModelProviderCapabilities } from "./model-provider-capabilities.js";

function bundledPlugin(id: string) {
  const rootDir = path.resolve("extensions", id);
  const loaded = loadPluginManifest(rootDir, false);
  if (!loaded.ok) {
    throw new Error(loaded.error);
  }
  const { manifest } = loaded;
  return {
    id: manifest.id,
    rootDir,
    origin: "bundled" as const,
    providers: manifest.providers,
    providerAuthChoices: manifest.providerAuthChoices,
  };
}

function resolveCapabilities(pluginId: string, config: OpenClawConfig = {}) {
  return resolveModelProviderCapabilities({
    config,
    metadataSnapshot: createPluginMetadataSnapshotFixture({ plugins: [bundledPlugin(pluginId)] }),
    workspaceDir: path.resolve("workspace-fixture"),
  }).capabilities;
}

it("offers Meta API keys and Muse device sign-in before the Muse runtime is installed or enabled", () => {
  const capabilities = resolveCapabilities("meta", {
    plugins: { entries: { meta: { enabled: true }, muse: { enabled: false } } },
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

it("offers llmman a quick API-key setup", () => {
  expect(resolveCapabilities("llmman")).toMatchObject([
    { provider: "llmman", apiKeySupported: true, quickApiKeySetup: true },
  ]);
});
