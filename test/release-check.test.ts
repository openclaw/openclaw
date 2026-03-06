import { describe, expect, it } from "vitest";
import {
  collectAppcastSparkleVersionErrors,
  collectMacBinaryArchitectureErrors,
} from "../scripts/release-check.ts";

function makeItem(shortVersion: string, sparkleVersion: string): string {
  return `<item><title>${shortVersion}</title><sparkle:shortVersionString>${shortVersion}</sparkle:shortVersionString><sparkle:version>${sparkleVersion}</sparkle:version></item>`;
}

describe("collectAppcastSparkleVersionErrors", () => {
  it("accepts legacy 9-digit calver builds before lane-floor cutover", () => {
    const xml = `<rss><channel>${makeItem("2026.2.26", "202602260")}</channel></rss>`;

    expect(collectAppcastSparkleVersionErrors(xml)).toEqual([]);
  });

  it("requires lane-floor builds on and after lane-floor cutover", () => {
    const xml = `<rss><channel>${makeItem("2026.3.1", "202603010")}</channel></rss>`;

    expect(collectAppcastSparkleVersionErrors(xml)).toEqual([
      "appcast item '2026.3.1' has sparkle:version 202603010 below lane floor 2026030190.",
    ]);
  });

  it("accepts canonical stable lane builds on and after lane-floor cutover", () => {
    const xml = `<rss><channel>${makeItem("2026.3.1", "2026030190")}</channel></rss>`;

    expect(collectAppcastSparkleVersionErrors(xml)).toEqual([]);
  });
});

describe("collectMacBinaryArchitectureErrors", () => {
  it("accepts universal arm64+x86_64 mac binaries", () => {
    const lipoInfo = "Architectures in the fat file: OpenClaw are: x86_64 arm64";
    expect(collectMacBinaryArchitectureErrors(lipoInfo)).toEqual([]);
  });

  it("rejects arm64-only mac binaries", () => {
    const lipoInfo = "Non-fat file: OpenClaw is architecture: arm64";
    expect(collectMacBinaryArchitectureErrors(lipoInfo)).toEqual([
      "OpenClaw macOS binary is missing required architecture(s): x86_64 (lipo: Non-fat file: OpenClaw is architecture: arm64)",
    ]);
  });
});
