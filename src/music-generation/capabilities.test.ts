import { describe, expect, it } from "vitest";
import {
  listSupportedMusicGenerationModes,
  resolveMusicGenerationModeCapabilities,
} from "./capabilities.js";

describe("music-generation capabilities", () => {
  it("requires explicit edit capabilities before advertising edit mode", () => {
    expect(listSupportedMusicGenerationModes({ capabilities: { maxInputImages: 2 } })).toEqual([
      "generate",
    ]);
  });

  it("detects generate vs edit mode from reference images", () => {
    expect(resolveMusicGenerationModeCapabilities({ inputImageCount: 0 })).toEqual({
      mode: "generate",
      capabilities: undefined,
    });
    expect(resolveMusicGenerationModeCapabilities({ inputImageCount: 1 })).toEqual({
      mode: "edit",
      capabilities: undefined,
    });
  });

  it("does not infer edit capabilities from aggregate fields", () => {
    expect(
      resolveMusicGenerationModeCapabilities({
        provider: { capabilities: { maxInputImages: 1 } },
        inputImageCount: 1,
      }),
    ).toEqual({ mode: "edit", capabilities: undefined });
  });
});
