import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaUnderstandingProvider } from "../media-understanding/types.js";

const state = vi.hoisted(() => ({
  prepared: false,
  prepare: vi.fn<() => Promise<() => void>>(),
  prepareNative: vi.fn<() => void>(),
}));

const providerRegistry = new Map<string, MediaUnderstandingProvider>([
  [
    "fixture",
    {
      id: "fixture",
      capabilities: ["audio"],
      defaultModels: { audio: "fixture-transcription" },
      autoPriority: { audio: 1 },
    },
  ],
]);

// mock-isolation: Compatibility cases control readiness without the process discovery cache.
vi.mock("../plugins/bundled-discovery-state.js", () => ({
  prepareBundledDiscoveryMode: state.prepare,
}));
// mock-isolation: Legacy SDK preparation must not open the real native machine-state owner.
vi.mock("../plugins/bundled-discovery-state.native.js", () => ({
  prepareBundledDiscoveryModeNative: state.prepareNative,
}));
// mock-isolation: The readiness gate returns only the fixture registry, without manifest discovery.
vi.mock("../media-understanding/manifest-metadata.js", () => ({
  buildMediaUnderstandingManifestMetadataRegistry: () => {
    if (!state.prepared) {
      throw new Error("discovery has not been prepared");
    }
    return providerRegistry;
  },
}));

import {
  resolveAutoMediaKeyProviders,
  resolveAutoMediaKeyProvidersAsync,
  resolveDefaultMediaModel,
  resolveDefaultMediaModelAsync,
} from "./media-runtime.js";

const params = { capability: "audio", providerId: "fixture" } as const;

describe("media discovery SDK compatibility", () => {
  beforeEach(() => {
    state.prepared = false;
    state.prepare.mockReset().mockImplementation(async () => {
      state.prepared = true;
      return () => {};
    });
    state.prepareNative.mockReset().mockImplementation(() => {
      state.prepared = true;
    });
  });

  it("retains synchronous results and emits one migration warning for legacy discovery", () => {
    using warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});

    expect(resolveAutoMediaKeyProviders(params)).toEqual(["fixture"]);
    expect(resolveDefaultMediaModel(params)).toBe("fixture-transcription");
    expect(warning).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining("resolveAutoMediaKeyProvidersAsync"),
      { code: "DEP_PLUGIN_SDK", type: "DeprecationWarning" },
    );
    expect(state.prepare).not.toHaveBeenCalled();
  });

  it("awaits discovery before resolving providers and models", async () => {
    const preparation = Promise.withResolvers<() => void>();
    state.prepare.mockReturnValue(preparation.promise);
    const providers = resolveAutoMediaKeyProvidersAsync(params);
    const model = resolveDefaultMediaModelAsync(params);

    state.prepared = true;
    preparation.resolve(() => {});

    await expect(providers).resolves.toEqual(["fixture"]);
    await expect(model).resolves.toBe("fixture-transcription");
    expect(state.prepareNative).not.toHaveBeenCalled();
  });

  it("uses an explicitly supplied registry without discovery storage", async () => {
    const supplied = { ...params, providerRegistry };

    expect(resolveAutoMediaKeyProviders(supplied)).toEqual(["fixture"]);
    expect(resolveDefaultMediaModel(supplied)).toBe("fixture-transcription");
    await expect(resolveAutoMediaKeyProvidersAsync(supplied)).resolves.toEqual(["fixture"]);
    await expect(resolveDefaultMediaModelAsync(supplied)).resolves.toBe("fixture-transcription");
    expect(state.prepare).not.toHaveBeenCalled();
    expect(state.prepareNative).not.toHaveBeenCalled();
  });
});
