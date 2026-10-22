import path from "node:path";
import { expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { loadPluginManifest } from "../../plugins/manifest.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { resolveModelProviderCapabilities } from "./model-provider-capabilities.js";

it("offers LM Studio's declared setup action separately from credential-only login", () => {
  const rootDir = path.resolve("extensions/lmstudio");
  const loaded = loadPluginManifest(rootDir, false);
  if (!loaded.ok) {
    throw new Error(loaded.error);
  }
  const { manifest } = loaded;
  const { capabilities } = resolveModelProviderCapabilities({
    config: {},
    workspaceDir: path.resolve("workspace-fixture"),
    metadataSnapshot: createPluginMetadataSnapshotFixture({
      plugins: [
        {
          id: manifest.id,
          rootDir,
          origin: "bundled",
          providers: manifest.providers,
          providerAuthChoices: manifest.providerAuthChoices,
        },
      ],
    }),
  });

  expect(capabilities).toEqual([
    {
      provider: "lmstudio",
      apiKeySupported: false,
      quickApiKeySetup: false,
      setupActions: [
        {
          choiceId: "lmstudio",
          label: "LM Studio",
          hint: "Connect to a running LM Studio server and use an already loaded model",
          actionLabel: "Connect server",
        },
      ],
    },
  ]);
});

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
