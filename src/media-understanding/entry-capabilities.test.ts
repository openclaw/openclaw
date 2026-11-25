import { describe, expect, it } from "vitest";
import { resolveEffectiveMediaEntryCapabilities } from "./entry-capabilities.js";
import type {
  MediaUnderstandingCapability,
  MediaUnderstandingCapabilityRegistry,
} from "./types.js";

describe("shared media entry capability inference", () => {
  const capabilities: MediaUnderstandingCapability[] = ["audio", "image"];
  it.each([
    { sharedEntryCapabilities: undefined, expected: ["audio", "image"] },
    { sharedEntryCapabilities: [], expected: [] },
    {
      sharedEntryCapabilities: ["image", "video"] as MediaUnderstandingCapability[],
      expected: ["image"],
    },
  ])(
    "narrows shared metadata $sharedEntryCapabilities against effective capabilities",
    ({ sharedEntryCapabilities, expected }) => {
      const providerRegistry: MediaUnderstandingCapabilityRegistry = new Map([
        ["acme", { capabilities, sharedEntryCapabilities }],
      ]);
      expect(
        resolveEffectiveMediaEntryCapabilities({ entry: { provider: "acme" }, providerRegistry }),
      ).toEqual(expected);
      expect(
        resolveEffectiveMediaEntryCapabilities({
          entry: { provider: "acme", capabilities: ["video"] },
          providerRegistry,
        }),
      ).toEqual(["video"]);
      expect(
        resolveEffectiveMediaEntryCapabilities({
          entry: { provider: "acme", type: "cli", command: "fixture" },
          providerRegistry,
        }),
      ).toBeUndefined();
    },
  );

  it("does not grant runtime aliases shared inference or metadata without effective capability", () => {
    const providerRegistry: MediaUnderstandingCapabilityRegistry = new Map([
      ["acme", { sharedEntryCapabilities: ["image"] }],
    ]);
    expect(
      resolveEffectiveMediaEntryCapabilities({ entry: { provider: "acme" }, providerRegistry }),
    ).toEqual([]);
    expect(
      resolveEffectiveMediaEntryCapabilities({
        entry: { provider: "acme-alias" },
        providerRegistry,
      }),
    ).toBeUndefined();
  });
});
