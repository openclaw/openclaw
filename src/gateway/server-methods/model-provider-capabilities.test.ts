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
