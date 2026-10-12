// Media defaults honor provider metadata, configured models, and execution aliases.
import { describe, expect, it, vi } from "vitest";
import type { MediaUnderstandingCapability, MediaUnderstandingProvider } from "./types.js";

const mediaMetadataPlugins = vi.hoisted(() => [
  {
    contracts: {
      mediaUnderstandingProviders: ["google", "minimax", "minimax-portal", "openrouter"],
    },
    mediaUnderstandingProviderMetadata: {
      google: { capabilities: ["image"], autoPriority: { image: 30 } },
      minimax: {
        capabilities: ["image"],
        autoPriority: { image: 40 },
        documentModels: { pdf: { textExtraction: "MiniMax-M2.7", image: false } },
      },
      "minimax-portal": {
        capabilities: ["image"],
        autoPriority: { image: 50 },
        documentModels: { pdf: { textExtraction: "MiniMax-M2.7", image: false } },
      },
      openrouter: { capabilities: ["image"], defaultModels: { image: "auto" } },
    },
  },
]);

vi.mock("../plugins/manifest-contract-eligibility.js", () => {
  const manifestRegistry = { plugins: mediaMetadataPlugins, diagnostics: [] };
  return {
    loadManifestMetadataSnapshot: () => ({
      index: { plugins: [] },
      plugins: mediaMetadataPlugins,
      manifestRegistry,
    }),
  };
});

import {
  providerSupportsNativePdfDocument,
  resolveAutoMediaKeyProviders,
  resolveDefaultMediaModel,
  resolveDocumentMediaModel,
} from "./defaults.js";

describe("resolveDefaultMediaModel", () => {
  it("uses supplied image registry defaults before configured models", () => {
    const capability = "image";
    const providerRegistry = new Map<string, MediaUnderstandingProvider>([
      ["google", { id: "google", defaultModels: { [capability]: "  registry-model  " } }],
      ["blank", { id: "blank", defaultModels: { [capability]: " \t " } }],
    ]);
    const models = [" GEMINI ", "blank", "missing"].map((providerId) =>
      resolveDefaultMediaModel({
        capability,
        providerId,
        providerRegistry,
        cfg: {
          models: {
            providers: {
              google: {
                baseUrl: "https://example.invalid",
                models: [
                  {
                    id: "configured-image",
                    name: "configured",
                    input: ["image"],
                    reasoning: false,
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    maxTokens: 1024,
                  },
                ],
              },
            },
          },
        },
      }),
    );
    expect(models).toEqual(["registry-model", undefined, undefined]);
  });

  it("prefers configured image models before manifest defaults", () => {
    const cfg = {
      models: {
        providers: {
          openrouter: {
            models: [{ id: "google/gemini-2.5-flash", input: ["text", "image"] }],
          },
        },
      },
    } as never;

    expect(resolveDefaultMediaModel({ providerId: "openrouter", capability: "image", cfg })).toBe(
      "google/gemini-2.5-flash",
    );
    expect(
      resolveDefaultMediaModel({
        providerId: "openrouter",
        capability: "image",
        cfg,
        includeConfiguredImageModels: false,
      }),
    ).toBe("auto");
  });
});

describe("resolveAutoMediaKeyProviders", () => {
  it.each<MediaUnderstandingCapability>(["image", "audio", "video"])(
    "orders %s priorities without conflating declared capabilities and runtime hooks",
    (capability) => {
      const hooks = {
        describeImage: async () => ({ text: "image" }),
        transcribeAudio: async () => ({ text: "audio" }),
        describeVideo: async () => ({ text: "video" }),
      };
      const providers: MediaUnderstandingProvider[] = [
        { id: "z-tie", capabilities: [capability], autoPriority: { [capability]: 2 } },
        { id: "a-tie", capabilities: [capability], autoPriority: { [capability]: 2 } },
        { id: "zero", capabilities: [capability], autoPriority: { [capability]: 0 } },
        { id: "negative", capabilities: [capability], autoPriority: { [capability]: -2 } },
        { id: "nan", capabilities: [capability], autoPriority: { [capability]: Number.NaN } },
        { id: "infinity", capabilities: [capability], autoPriority: { [capability]: Infinity } },
        { id: "declared-empty", capabilities: [], autoPriority: { [capability]: -10 }, ...hooks },
        { id: "hook-only", autoPriority: { [capability]: 1 }, ...hooks },
        { id: "no-hook", autoPriority: { [capability]: -20 } },
        { id: "gemini", capabilities: [capability], autoPriority: { [capability]: 3 } },
        { id: "google", capabilities: [capability], autoPriority: { [capability]: 4 } },
      ];
      const providerRegistry = new Map(providers.map((provider) => [provider.id, provider]));

      expect(resolveAutoMediaKeyProviders({ capability, providerRegistry })).toEqual([
        "negative",
        "zero",
        "hook-only",
        "a-tie",
        "z-tie",
        "google",
        "google",
      ]);
      expect([...providerRegistry.values()]).toEqual(providers);
    },
  );

  it("preserves configured MiniMax CN aliases for image auto discovery", () => {
    const providers = resolveAutoMediaKeyProviders({
      capability: "image",
      cfg: {
        models: {
          providers: {
            "minimax-cn": {
              models: [{ id: "MiniMax-M2.7", input: ["text", "image"] }],
            },
            "minimax-portal-cn": {
              models: [{ id: "MiniMax-M2.7", input: ["text", "image"] }],
            },
            gemini: {
              models: [{ id: "gemini-3-flash-preview", input: ["text", "image"] }],
            },
          },
        },
      } as never,
    });

    expect(providers).toContain("minimax-cn");
    expect(providers).toContain("minimax-portal-cn");
    expect(providers).not.toContain("gemini");
    expect(providers).toContain("google");
    expect(providers.indexOf("minimax-cn")).toBeLessThan(providers.indexOf("minimax"));
    expect(providers.indexOf("minimax-portal-cn")).toBeLessThan(
      providers.indexOf("minimax-portal"),
    );
  });
});

describe("providerSupportsNativePdfDocument", () => {
  it("reads native PDF support from provider metadata", () => {
    const providerRegistry = new Map([
      ["anthropic", { id: "anthropic", nativeDocumentInputs: ["pdf" as const] }],
      ["google", { id: "google", nativeDocumentInputs: ["pdf" as const] }],
      ["openai", { id: "openai", nativeDocumentInputs: [] }],
    ]);
    expect(providerSupportsNativePdfDocument({ providerId: "anthropic", providerRegistry })).toBe(
      true,
    );
    expect(providerSupportsNativePdfDocument({ providerId: "google", providerRegistry })).toBe(
      true,
    );
    expect(providerSupportsNativePdfDocument({ providerId: "openai", providerRegistry })).toBe(
      false,
    );
  });
});

describe("resolveDocumentMediaModel", () => {
  it("reads document model hints from provider metadata", () => {
    expect(
      resolveDocumentMediaModel({
        providerId: "minimax-portal-cn",
        document: "pdf",
        mode: "textExtraction",
      }),
    ).toBe("MiniMax-M2.7");
    expect(
      resolveDocumentMediaModel({
        providerId: "minimax",
        document: "pdf",
        mode: "image",
      }),
    ).toBe(false);
    expect(
      resolveDocumentMediaModel({
        providerId: "openai",
        document: "pdf",
        mode: "textExtraction",
      }),
    ).toBeUndefined();
  });
});
