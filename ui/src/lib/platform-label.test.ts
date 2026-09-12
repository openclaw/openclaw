// @vitest-environment node
import { describe, expect, it } from "vitest";
import { prettifyPlatform } from "./platform-label.ts";

describe("prettifyPlatform", () => {
  it.each([
    ["darwin", "macOS"],
    ["MacIntel", "MacIntel"],
    ["iOS 26.4", "iOS 26.4"],
    ["freebsd", "FreeBSD"],
    ["openbsd", "OpenBSD"],
    ["netbsd", "NetBSD"],
    ["Haiku", "Haiku"],
    ["constructor", "Constructor"],
    ["Haiku constructor", "Haiku constructor"],
    ["win32 11", "Windows 11"],
    ["Win64", "Windows"],
    ["MacARM", "macOS (ARM)"],
    ["MacARM64", "macOS (ARM)"],
    ["arm64-apple-darwin", "macOS (ARM)"],
    ["aarch64-apple-darwin", "macOS (ARM)"],
    ["x86_64-apple-darwin", "macOS (Intel)"],
    ["Linux aarch64", "Linux (ARM)"],
    ["linux armv8l", "Linux (ARM)"],
    ["linux x86_64", "Linux (x64)"],
    ["windows 11 arm64", "Windows 11 (ARM)"],
    ["Windows amd64", "Windows (x64)"],
    ["Linux i686", "Linux (x86)"],
    ["macos 27.0.0", "macOS 27.0.0"],
  ])("formats %s as %s", (platform, expected) => {
    expect(prettifyPlatform(platform)).toBe(expected);
  });

  it.each([
    ["Mac", "macOS"],
    ["iPad", "iPadOS"],
    ["unknown", "MacIntel"],
  ])("uses device family %s without inferring an Intel CPU", (family, expected) => {
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
