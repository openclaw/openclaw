import { describe, expect, it, vi } from "vitest";
import type { MediaUnderstandingProvider } from "./types.js";

const mediaMetadataPlugins = vi.hoisted(() => {
  const pdf = { pdf: { textExtraction: "MiniMax-M2.7", image: false } };
  const minimax = { capabilities: ["image"], documentModels: pdf };
  return [
    {
      contracts: {
        mediaUnderstandingProviders: ["google", "minimax", "minimax-portal", "openrouter"],
      },
      mediaUnderstandingProviderMetadata: {
        google: { capabilities: ["image"], autoPriority: { image: 30 } },
        minimax: { ...minimax, autoPriority: { image: 40 } },
        "minimax-portal": { ...minimax, autoPriority: { image: 50 } },
        openrouter: { capabilities: ["image"], defaultModels: { image: "auto" } },
      },
    },
  ];
});

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

function imageModels(id: string) {
  return { models: [{ id, input: ["text", "image"] }] };
}

describe("media defaults", () => {
  it("prefers configured image models before manifest defaults", () => {
    const cfg = {
      models: { providers: { openrouter: imageModels("google/gemini-2.5-flash") } },
    } as never;
    const params = { providerId: "openrouter", capability: "image" as const, cfg };

    expect(resolveDefaultMediaModel(params)).toBe("google/gemini-2.5-flash");
    expect(resolveDefaultMediaModel({ ...params, includeConfiguredImageModels: false })).toBe(
      "auto",
    );
  });
  it("orders priorities without conflating declared capabilities and runtime hooks", () => {
    const capability = "video";
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
  });

  it("preserves configured MiniMax CN aliases for image auto discovery", () => {
    const providers = resolveAutoMediaKeyProviders({
      capability: "image",
      cfg: {
        models: {
          providers: {
            "minimax-cn": imageModels("MiniMax-M2.7"),
            "minimax-portal-cn": imageModels("MiniMax-M2.7"),
            gemini: imageModels("gemini-3-flash-preview"),
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
  it("reads native PDF support from provider metadata", () => {
    const providerRegistry = new Map([
      ["anthropic", { id: "anthropic", nativeDocumentInputs: ["pdf" as const] }],
      ["google", { id: "google", nativeDocumentInputs: ["pdf" as const] }],
      ["openai", { id: "openai", nativeDocumentInputs: [] }],
    ]);
    const supports = (providerId: string) =>
      providerSupportsNativePdfDocument({ providerId, providerRegistry });
    expect([supports("anthropic"), supports("google"), supports("openai")]).toEqual([
      true,
      true,
      false,
    ]);
  });
  it("reads document model hints from provider metadata", () => {
    const resolve = (providerId: string, mode: "textExtraction" | "image") =>
      resolveDocumentMediaModel({ providerId, mode });
    expect(resolve("minimax-portal-cn", "textExtraction")).toBe("MiniMax-M2.7");
    expect(resolve("minimax", "image")).toBe(false);
    expect(resolve("openai", "textExtraction")).toBeUndefined();
  });
});
