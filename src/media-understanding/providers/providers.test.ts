import { describe, expect, it } from "vitest";

import { buildMediaUnderstandingRegistry } from "./index.js";

describe("media understanding providers", () => {
  const registry = buildMediaUnderstandingRegistry();

  it("providers declare capabilities matching their implemented methods", () => {
    for (const [id, provider] of registry) {
      const declared = provider.capabilities ?? [];

      if (provider.transcribeAudio) {
        expect(
          declared.includes("audio"),
          `Provider "${id}" has transcribeAudio but doesn't declare "audio" capability`,
        ).toBe(true);
      }

      if (provider.describeImage) {
        expect(
          declared.includes("image"),
          `Provider "${id}" has describeImage but doesn't declare "image" capability`,
        ).toBe(true);
      }

      if (provider.describeVideo) {
        expect(
          declared.includes("video"),
          `Provider "${id}" has describeVideo but doesn't declare "video" capability`,
        ).toBe(true);
      }
    }
  });
});
