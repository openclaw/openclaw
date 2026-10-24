import { describe, expect, it } from "vitest";
import { normalizeVideoGenerationDuration } from "./duration-support.js";
import type { VideoGenerationProvider } from "./types.js";

describe("normalizeVideoGenerationDuration explicit durations", () => {
  const provider: VideoGenerationProvider = {
    id: "synthetic-video",
    label: "Synthetic video",
    capabilities: { generate: { supportedDurationSeconds: [10, 20] } },
    generateVideo: async () => ({ videos: [] }),
  };

  it.each([
    { supportedDurationSeconds: [4, 8], durationSeconds: 6, expected: 8 },
    { supportedDurationSeconds: [], durationSeconds: 6.3, expected: 6 },
  ])("uses explicit $supportedDurationSeconds instead of provider capabilities", (params) => {
    expect(
      normalizeVideoGenerationDuration({
        provider,
        durationSeconds: params.durationSeconds,
        supportedDurationSeconds: params.supportedDurationSeconds,
      }),
    ).toBe(params.expected);
  });
});
