import path from "node:path";
import { expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { loadPluginManifest } from "../../plugins/manifest.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { resolveBundledPluginPublicModulePath } from "../../test-utils/bundled-plugin-public-surface.js";
import type { ModelAuthStatusResult } from "./models-auth-status.types.js";

export function defineModelAuthCapabilityTests({
  setPreparedMetadataSnapshot,
  readAuthStatus,
  setConfig,
}: {
  setPreparedMetadataSnapshot: (snapshot: PluginMetadataSnapshot) => void;
  readAuthStatus: () => Promise<ModelAuthStatusResult>;
  setConfig: (config: OpenClawConfig) => void;
}) {
  it("projects provider capabilities from the published lifecycle metadata", async () => {
    const snapshot = createPluginMetadataSnapshotFixture({
      plugins: [
        {
          id: "provider-auth",
          origin: "bundled",
          providers: ["OpenAI", "github-copilot", "media-only"],
          providerAuthAliases: { "openai-legacy": "openai" },
          providerAuthChoices: [
            {
              provider: "openai-legacy",
              method: "api-key",
              choiceId: "openai-api-key",
              choiceLabel: "OpenAI API key",
              appGuidedSecret: true,
            },
            {
              provider: "openai",
              method: "oauth",
              choiceId: "openai-oauth",
              choiceLabel: "OpenAI OAuth",
            },
            {
              provider: "media-only",
              method: "api-key",
              choiceId: "media-only-key",
              choiceLabel: "Media API key",
              onboardingScopes: ["image-generation"],
            },
            {
              provider: "github-copilot",
              method: "oauth",
              choiceId: "github-copilot-oauth",
              choiceLabel: "GitHub Copilot OAuth",
            },
          ],
        },
        {
          id: "search-tool",
          setup: { providers: [{ id: "search-tool", authMethods: ["api-key"] }] },
        },
      ],
    });
    setPreparedMetadataSnapshot(snapshot);

    const result = await readAuthStatus();

    expect(
      result.providerCapabilities?.map(({ provider, apiKeySupported, quickApiKeySetup }) => ({
        provider,
        apiKeySupported,
        quickApiKeySetup,
      })),
    ).toEqual([
      { provider: "github-copilot", apiKeySupported: false, quickApiKeySetup: false },
      { provider: "openai", apiKeySupported: true, quickApiKeySetup: true },
    ]);
    expect(
      result.providerCapabilities?.flatMap((provider) => provider.setupOptions ?? []),
    ).toHaveLength(3);
    setConfig({
      plugins: { entries: { "provider-auth": { enabled: false } } },
    });
    const disabled = await readAuthStatus();
    expect(
      disabled.providerCapabilities?.flatMap((provider) => provider.setupOptions ?? []),
    ).toEqual([]);
  });

  it("offers bundled key, token, browser, and device logins before any credentials exist", async () => {
    setPreparedMetadataSnapshot(
      createPluginMetadataSnapshotFixture({
        plugins: [
          "anthropic",
          "openai",
          "minimax",
          "longcat",
          "clawrouter",
          "nvidia",
          "cloudflare-ai-gateway",
          "google",
        ].map((pluginId) => {
          const loaded = loadPluginManifest(
            path.dirname(
              resolveBundledPluginPublicModulePath({
                pluginId,
                artifactBasename: "openclaw.plugin.json",
              }),
            ),
          );
          if (!loaded.ok) {
            throw new Error(loaded.error);
          }
          return loaded.manifest;
        }),
      }),
    );

    const result = await readAuthStatus();
    const options = result.providerCapabilities?.flatMap((provider) => provider.loginOptions ?? []);

    expect(
      options
        ?.filter((option) => ["anthropic", "openai"].includes(option.brandId))
        .map(({ id, kind }) => ({ id, kind })),
    ).toEqual([
      { id: "anthropic/apiKey", kind: "secret" },
      { id: "anthropic/setup-token", kind: "secret" },
      { id: "openai/openai-token-sharing", kind: "oauth" },
      { id: "openai/openai-device-code", kind: "device-code" },
      { id: "openai/openai", kind: "oauth" },
      { id: "openai/openai-api-key", kind: "secret" },
    ]);
    for (const provider of ["minimax", "minimax-portal"]) {
      const capability = result.providerCapabilities?.find((item) => item.provider === provider);
      expect(capability?.loginOptions).toHaveLength(2);
      expect(capability?.loginOptions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ brandId: provider, groupId: "minimax", groupLabel: "MiniMax" }),
        ]),
      );
    }
    for (const provider of ["longcat", "clawrouter", "nvidia"]) {
      expect(result.providerCapabilities?.find((item) => item.provider === provider)).toMatchObject(
        {
          quickApiKeySetup: true,
          loginOptions: [{ brandId: provider, groupId: provider, kind: "secret" }],
        },
      );
    }
    const setup = result.providerCapabilities?.flatMap((provider) => provider.setupOptions ?? []);
    expect(setup?.map((option) => option.id)).toEqual([
      "anthropic/anthropic-cli",
      "cloudflare-ai-gateway/cloudflare-ai-gateway-api-key",
      "google/google-vertex-api-key",
    ]);
    expect(options?.some((option) => setup?.some((entry) => entry.id === option.id))).toBe(false);
  });
}
