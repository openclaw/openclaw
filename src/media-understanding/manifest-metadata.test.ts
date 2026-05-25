import { beforeEach, describe, expect, it, vi } from "vitest";

const manifestMocks = vi.hoisted(() => ({
  isAvailable: vi.fn(() => true),
  plugins: [] as Array<{
    id: string;
    origin?: string;
    contracts?: { mediaUnderstandingProviders?: string[] };
    mediaUnderstandingProviderMetadata?: Record<string, unknown>;
  }>,
}));

vi.mock("../plugins/manifest-contract-eligibility.js", () => ({
  isManifestPluginAvailableForControlPlane: manifestMocks.isAvailable,
  loadManifestMetadataSnapshot: () => ({
    index: { plugins: [] },
    plugins: manifestMocks.plugins,
  }),
}));

import {
  buildMediaUnderstandingManifestMetadataRegistry,
  hasAvailableMediaUnderstandingManifestMetadataGaps,
} from "./manifest-metadata.js";

describe("buildMediaUnderstandingManifestMetadataRegistry", () => {
  beforeEach(() => {
    manifestMocks.isAvailable.mockReset().mockReturnValue(true);
    manifestMocks.plugins.length = 0;
  });

  it("lists declared audio provider metadata without loading provider runtime", () => {
    manifestMocks.plugins.push({
      id: "senseaudio",
      origin: "bundled",
      contracts: { mediaUnderstandingProviders: ["senseaudio"] },
      mediaUnderstandingProviderMetadata: {
        senseaudio: {
          capabilities: ["audio"],
          defaultModels: { audio: "senseaudio-asr-pro-1.5-260319" },
          autoPriority: { audio: 40 },
        },
      },
    });

    expect(buildMediaUnderstandingManifestMetadataRegistry().get("senseaudio")).toEqual({
      id: "senseaudio",
      capabilities: ["audio"],
      defaultModels: { audio: "senseaudio-asr-pro-1.5-260319" },
      autoPriority: { audio: 40 },
      nativeDocumentInputs: undefined,
    });
  });

  it("does not report bundled providers when plugins are globally disabled", () => {
    manifestMocks.plugins.push({
      id: "senseaudio",
      origin: "bundled",
      contracts: { mediaUnderstandingProviders: ["senseaudio"] },
      mediaUnderstandingProviderMetadata: {
        senseaudio: {
          capabilities: ["audio"],
          defaultModels: { audio: "senseaudio-asr-pro-1.5-260319" },
        },
      },
    });

    expect(
      buildMediaUnderstandingManifestMetadataRegistry({ plugins: { enabled: false } }),
    ).toEqual(new Map());
    expect(manifestMocks.isAvailable).not.toHaveBeenCalled();
  });

  it("does not report providers rejected by plugin activation policy", () => {
    manifestMocks.isAvailable.mockReturnValue(false);
    manifestMocks.plugins.push({
      id: "senseaudio",
      origin: "bundled",
      contracts: { mediaUnderstandingProviders: ["senseaudio"] },
      mediaUnderstandingProviderMetadata: {
        senseaudio: {
          capabilities: ["audio"],
        },
      },
    });

    expect(buildMediaUnderstandingManifestMetadataRegistry()).toEqual(new Map());
  });

  it("does not report bundled providers excluded by plugins.allow", () => {
    manifestMocks.plugins.push({
      id: "senseaudio",
      origin: "bundled",
      contracts: { mediaUnderstandingProviders: ["senseaudio"] },
      mediaUnderstandingProviderMetadata: {
        senseaudio: {
          capabilities: ["audio"],
        },
      },
    });

    expect(
      buildMediaUnderstandingManifestMetadataRegistry({ plugins: { allow: ["codex"] } }),
    ).toEqual(new Map());
  });

  it("does not report bundled providers disabled by plugin entry config", () => {
    manifestMocks.plugins.push({
      id: "senseaudio",
      origin: "bundled",
      contracts: { mediaUnderstandingProviders: ["senseaudio"] },
      mediaUnderstandingProviderMetadata: {
        senseaudio: {
          capabilities: ["audio"],
        },
      },
    });

    expect(
      buildMediaUnderstandingManifestMetadataRegistry({
        plugins: { entries: { senseaudio: { enabled: false } } },
      }),
    ).toEqual(new Map());
  });

  it("detects available providers that need runtime compatibility fallback", () => {
    manifestMocks.plugins.push({
      id: "external-audio",
      origin: "global",
      contracts: { mediaUnderstandingProviders: ["external-audio"] },
    });

    expect(hasAvailableMediaUnderstandingManifestMetadataGaps()).toBe(true);
  });

  it("does not trigger runtime fallback for unavailable metadata-less providers", () => {
    manifestMocks.isAvailable.mockReturnValue(false);
    manifestMocks.plugins.push({
      id: "external-audio",
      origin: "global",
      contracts: { mediaUnderstandingProviders: ["external-audio"] },
    });

    expect(hasAvailableMediaUnderstandingManifestMetadataGaps()).toBe(false);
  });
});
