import { describe, expect, it } from "vitest";
import {
  musicGenerationProviderContractRegistry,
  videoGenerationProviderContractRegistry,
} from "./media-provider-registry.js";
import {
  musicGenerationProviderContractRegistry as canonicalMusicGenerationProviderContractRegistry,
  videoGenerationProviderContractRegistry as canonicalVideoGenerationProviderContractRegistry,
} from "./registry.js";

describe("media provider registry", () => {
  it("re-exports the canonical video and music provider registries", () => {
    expect(videoGenerationProviderContractRegistry).toBe(
      canonicalVideoGenerationProviderContractRegistry,
    );
    expect(musicGenerationProviderContractRegistry).toBe(
      canonicalMusicGenerationProviderContractRegistry,
    );
  });
});
