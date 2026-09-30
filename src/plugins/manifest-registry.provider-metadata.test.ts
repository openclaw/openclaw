import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { PluginCandidate } from "./discovery.js";
import { loadPluginManifestRegistryCore } from "./manifest-registry.js";
import { mkdirSafeDir } from "./test-helpers/fs-fixtures.js";

vi.unmock("../version.js");

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function makeTempDir() {
  const dir = tempDirs.make("openclaw-manifest-provider-metadata-");
  mkdirSafeDir(dir);
  return dir;
}

function writeManifest(dir: string, manifest: Record<string, unknown>) {
  fs.writeFileSync(path.join(dir, "openclaw.plugin.json"), JSON.stringify(manifest), "utf-8");
}

function loadSingleCandidateRegistry(
  params: Pick<PluginCandidate, "idHint" | "rootDir" | "origin">,
) {
  return loadPluginManifestRegistryCore({
    candidates: [{ ...params, source: path.join(params.rootDir, "index.ts") }],
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("loadPluginManifestRegistry provider metadata", () => {
  it("preserves provider and executor contracts from plugin manifests", () => {
    const dir = makeTempDir();
    writeManifest(dir, {
      id: "acme-ai",
      providers: ["acme-ai"],
      contracts: {
        codeModeExecutors: [" quickjs ", ""],
        externalAuthProviders: ["acme-ai"],
        usageProviders: ["acme-ai"],
        workerProviders: [" static-ssh ", ""],
      },
      configSchema: { type: "object" },
    });

    const registry = loadSingleCandidateRegistry({
      idHint: "acme-ai",
      rootDir: dir,
      origin: "bundled",
    });

    expect(registry.plugins[0]?.contracts).toEqual({
      codeModeExecutors: ["quickjs"],
      externalAuthProviders: ["acme-ai"],
      usageProviders: ["acme-ai"],
      workerProviders: ["static-ssh"],
    });
  });

  it("normalizes provider metadata from plugin manifests", () => {
    const dir = makeTempDir();
    writeManifest(dir, {
      id: "openai",
      enabledByDefault: true,
      enabledByDefaultOnPlatforms: ["darwin", "not-a-platform"],
      providers: ["openai", "openai"],
      setup: {
        providers: [{ id: "openai", envVars: ["OPENAI_API_KEY"] }],
      },
      providerEndpoints: [
        {
          endpointClass: "openai-public",
          hosts: ["API.OPENAI.COM", ""],
          hostSuffixes: [".openai.azure.com"],
          baseUrls: ["https://api.openai.com/v1"],
          googleVertexRegion: "global",
          googleVertexRegionHostSuffix: "-aiplatform.googleapis.com",
        },
      ],
      modelIdNormalization: {
        providers: {
          openai: {
            aliases: {
              "gpt-latest": "gpt-5.4",
            },
            stripPrefixes: ["openai/"],
            prefixWhenBare: "openai",
            prefixWhenBareAfterAliasStartsWith: [
              {
                modelPrefix: "gpt-",
                prefix: "openai",
              },
              {
                modelPrefix: "",
                prefix: "ignored",
              },
            ],
          },
          ignored: {
            prefixWhenBare: "ignored",
          },
        },
      },
      providerRequest: {
        providers: {
          openai: {
            family: "openai-family",
            compatibilityFamily: "moonshot",
            openAICompletions: {
              supportsStreamingUsage: true,
            },
          },
          ignored: {
            family: "ignored",
          },
        },
      },
      syntheticAuthRefs: ["openai-cli"],
      nonSecretAuthMarkers: ["openai-cli"],
      providerAuthAliases: {
        openai: "openai",
      },
      providerAuthChoices: [
        {
          provider: "openai",
          method: "api-key",
          choiceId: "openai-api-key",
          choiceLabel: "OpenAI API key",
          icon: "HTTPS://CDN.SIMPLEICONS.ORG/openai",
          modelTarget: "utility",
          platforms: ["darwin", "not-a-platform"],
          website: "https://platform.openai.com/api-keys",
          docsUrl: "HTTPS://DOCS.EXAMPLE.COM/authentication",
          assistantPriority: 10,
          assistantVisibility: "detected-only",
          appGuidedSecret: true,
          personalAccount: true,
          appGuidedActionLabel: "Connect account",
          appGuidedDiscovery: true,
        },
      ],
      configSchema: { type: "object" },
    });

    const registry = loadSingleCandidateRegistry({
      idHint: "openai",
      rootDir: dir,
      origin: "bundled",
    });

    expect(registry.plugins[0]?.providerEndpoints).toEqual([
      {
        endpointClass: "openai-public",
        hosts: ["api.openai.com"],
        hostSuffixes: [".openai.azure.com"],
        baseUrls: ["https://api.openai.com/v1"],
        googleVertexRegion: "global",
        googleVertexRegionHostSuffix: "-aiplatform.googleapis.com",
      },
    ]);
    expect(registry.plugins[0]?.modelIdNormalization).toEqual({
      providers: {
        openai: {
          aliases: {
            "gpt-latest": "gpt-5.4",
          },
          stripPrefixes: ["openai/"],
          prefixWhenBare: "openai",
          prefixWhenBareAfterAliasStartsWith: [
            {
              modelPrefix: "gpt-",
              prefix: "openai",
            },
          ],
        },
      },
    });
    expect(registry.plugins[0]?.providerRequest).toEqual({
      providers: {
        openai: {
          family: "openai-family",
          compatibilityFamily: "moonshot",
          openAICompletions: {
            supportsStreamingUsage: true,
          },
        },
      },
    });
    expect(registry.plugins[0]?.syntheticAuthRefs).toEqual(["openai-cli"]);
    expect(registry.plugins[0]?.nonSecretAuthMarkers).toEqual(["openai-cli"]);
    expect(registry.plugins[0]?.providerAuthAliases).toEqual({
      openai: "openai",
    });
    expect(registry.plugins[0]?.enabledByDefault).toBe(true);
    expect(registry.plugins[0]?.enabledByDefaultOnPlatforms).toEqual(["darwin"]);
    expect(registry.plugins[0]?.providerAuthChoices).toEqual([
      {
        provider: "openai",
        method: "api-key",
        choiceId: "openai-api-key",
        choiceLabel: "OpenAI API key",
        icon: "https://cdn.simpleicons.org/openai",
        modelTarget: "utility",
        platforms: ["darwin"],
        website: "https://platform.openai.com/api-keys",
        docsUrl: "https://docs.example.com/authentication",
        assistantPriority: 10,
        assistantVisibility: "detected-only",
        appGuidedSecret: true,
        personalAccount: true,
        appGuidedActionLabel: "Connect account",
        appGuidedDiscovery: true,
      },
    ]);
  });

  it.each([
    { platforms: [] },
    { platforms: ["not-a-platform"] },
    { platforms: "darwin" },
    { platforms: null },
  ])(
    "preserves an unavailable auth choice when its platform restriction is $platforms",
    ({ platforms }) => {
      const dir = makeTempDir();
      writeManifest(dir, {
        id: "native-provider",
        providerAuthChoices: [
          { provider: "native", method: "local", choiceId: "native-local", platforms },
        ],
        configSchema: { type: "object" },
      });

      const registry = loadSingleCandidateRegistry({
        idHint: "native-provider",
        rootDir: dir,
        origin: "bundled",
      });
      expect(registry.plugins[0]?.providerAuthChoices?.[0]?.platforms).toEqual([]);
    },
  );

  it("drops non-HTTPS provider auth presentation URLs", () => {
    const dir = makeTempDir();
    writeManifest(dir, {
      id: "unsafe-auth-artwork",
      providerAuthChoices: [
        {
          provider: "unsafe",
          method: "api-key",
          choiceId: "unsafe-api-key",
          icon: "http://example.com/icon.svg",
          website: "javascript:alert(1)",
          docsUrl: "javascript:alert(1)",
        },
        {
          provider: "oversized",
          method: "api-key",
          choiceId: "oversized-api-key",
          icon: `https://example.com/${"a".repeat(2048)}`,
          docsUrl: `https://example.com/${"a".repeat(2048)}`,
        },
      ],
      configSchema: { type: "object" },
    });

    const registry = loadSingleCandidateRegistry({
      idHint: "unsafe-auth-artwork",
      rootDir: dir,
      origin: "bundled",
    });

    expect(registry.plugins[0]?.providerAuthChoices).toEqual([
      {
        provider: "unsafe",
        method: "api-key",
        choiceId: "unsafe-api-key",
      },
      {
        provider: "oversized",
        method: "api-key",
        choiceId: "oversized-api-key",
      },
    ]);
  });
});
