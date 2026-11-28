import path from "node:path";
import { expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { loadPluginManifest } from "../../plugins/manifest.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { resolveModelProviderCapabilities } from "./model-provider-capabilities.js";

function bundledCapabilities(pluginIds: string[], config: OpenClawConfig) {
  const metadataSnapshot = createPluginMetadataSnapshotFixture({
    plugins: pluginIds.map((pluginId) => {
      const rootDir = path.resolve("extensions", pluginId);
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
    }),
  });
  return resolveModelProviderCapabilities({
    config,
    metadataSnapshot,
    workspaceDir: path.resolve("workspace-fixture"),
  }).capabilities;
}

it("offers Meta API keys and Muse device sign-in before the Muse runtime is installed or enabled", () => {
  const capabilities = bundledCapabilities(["meta"], {
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

it("tells the catalog which providers share a manifest group", () => {
  const capabilities = bundledCapabilities(["google", "minimax"], {
    plugins: { entries: { google: { enabled: true }, minimax: { enabled: true } } },
  });
  const groupOf = (provider: string) =>
    capabilities.find((entry) => entry.provider === provider)?.groupId;

  expect(groupOf("google")).toBe("google");
  expect(groupOf("minimax")).toBe("minimax");
  expect(groupOf("minimax-portal")).toBe("minimax");
});
