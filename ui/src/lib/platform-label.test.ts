// @vitest-environment node
import { describe, expect, it } from "vitest";
import { prettifyPlatform } from "./platform-label.ts";

describe("prettifyPlatform", () => {
  it.each([
    ["darwin", "macOS"],
    ["MacIntel", "MacIntel"],
    ["iOS 26.4", "iOS 26.4"],
    ["freebsd", "Freebsd"],
    ["Haiku", "Haiku"],
    ["win32 11", "Windows 11"],
  ])("formats %s as %s", (platform, expected) => {
    expect(prettifyPlatform(platform)).toBe(expected);
  });

  it.each([
    ["Mac", "macOS"],
    ["iPad", "iPadOS"],
    ["unknown", "MacIntel"],
  ])("uses device family %s to disambiguate MacIntel", (family, expected) => {
    expect(prettifyPlatform("MacIntel", family)).toBe(expected);
  });

  it.each([
    ["Win32", "iPad", "Windows"],
    ["iOS 26.4", "Mac", "iOS 26.4"],
    ["MacIntel 26.4", "Mac", "macOS 26.4"],
  ])(
    "preserves the platform and version contract for %s with family %s",
    (platform, family, expected) => {
      expect(prettifyPlatform(platform, family)).toBe(expected);
    },
  );
});
