import { describe, expect, it } from "vitest";
import { musicGenerationProviderContractRegistry } from "../plugins/contracts/registry.js";
import { listSupportedMusicGenerationModes } from "./capabilities.js";

describe("bundled music-generation provider capabilities", () => {
  it("declares explicit generate/edit support for every bundled provider", () => {
    expect(musicGenerationProviderContractRegistry.length).toBeGreaterThan(0);

    for (const entry of musicGenerationProviderContractRegistry) {
      const { provider } = entry;
      expect(
        provider.capabilities.generate,
        `${provider.id} missing generate capabilities`,
      ).toBeDefined();
      expect(provider.capabilities.edit, `${provider.id} missing edit capabilities`).toBeDefined();

      const edit = provider.capabilities.edit;
      if (!edit) {
        continue;
      }

      if (edit.enabled) {
        expect(
          edit.maxInputImages ?? 0,
          `${provider.id} edit.enabled requires maxInputImages`,
        ).toBeGreaterThan(0);
        expect(listSupportedMusicGenerationModes(provider)).toContain("edit");
      } else {
        expect(listSupportedMusicGenerationModes(provider)).toEqual(["generate"]);
      }
    }
  });
});
