import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { loadPluginManifestRegistryCore } from "./manifest-registry.js";
import { mkdirSafeDir } from "./test-helpers/fs-fixtures.js";

vi.unmock("../version.js");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
});

it.each([
  {
    name: "preserves provider and executor contracts from plugin manifests",
    manifest: {
      id: "acme-ai",
      providers: ["acme-ai"],
      contracts: {
        codeModeExecutors: [" quickjs ", ""],
        externalAuthProviders: ["acme-ai"],
        usageProviders: ["acme-ai"],
        workerProviders: [" static-ssh ", ""],
        storageProviders: [" archive-objects ", ""],
      },
      configSchema: { type: "object" },
    },
    expected: {
      contracts: {
        codeModeExecutors: ["quickjs"],
        externalAuthProviders: ["acme-ai"],
        usageProviders: ["acme-ai"],
        workerProviders: ["static-ssh"],
        storageProviders: ["archive-objects"],
      },
    },
  },
  {
    name: "normalizes provider metadata from plugin manifests",
    manifest: {
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
    },
    expected: {
      providerEndpoints: [
        {
          endpointClass: "openai-public",
          hosts: ["api.openai.com"],
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
            ],
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
        },
      },
      syntheticAuthRefs: ["openai-cli"],
      nonSecretAuthMarkers: ["openai-cli"],
      providerAuthAliases: {
        openai: "openai",
      },
      enabledByDefault: true,
      enabledByDefaultOnPlatforms: ["darwin"],
      providerAuthChoices: [
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
      ],
    },
  },
  {
    name: "drops non-HTTPS provider auth presentation URLs",
    manifest: {
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
    },
    expected: {
      providerAuthChoices: [
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
      ],
    },
  },
  ...[[], ["not-a-platform"], "darwin", null].map((platforms) => ({
    name: `preserves unavailable platform restriction ${JSON.stringify(platforms)}`,
    manifest: {
      id: "native-provider",
      configSchema: { type: "object" },
      providerAuthChoices: [
        { provider: "native", method: "local", choiceId: "native-local", platforms },
      ],
    },
    expected: {
      providerAuthChoices: [
        { provider: "native", method: "local", choiceId: "native-local", platforms: [] },
      ],
    },
  })),
])("$name", ({ manifest, expected }) => {
  const rootDir = tempDirs.make("openclaw-manifest-provider-metadata-");
  mkdirSafeDir(rootDir);
  fs.writeFileSync(path.join(rootDir, "openclaw.plugin.json"), JSON.stringify(manifest), "utf-8");
  const registry = loadPluginManifestRegistryCore({
    candidates: [
      { idHint: manifest.id, rootDir, origin: "bundled", source: path.join(rootDir, "index.ts") },
    ],
  });
  const plugin = registry.plugins[0];
  expect(plugin).toBeDefined();
  for (const [key, value] of Object.entries(expected)) {
    expect(plugin && Reflect.get(plugin, key), key).toEqual(value);
  }
});
