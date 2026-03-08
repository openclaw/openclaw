import { describe, expect, it } from "vitest";
import {
  collectAppcastSparkleVersionErrors,
  collectBundledExtensionRootDependencyGapErrors,
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

describe("collectBundledExtensionRootDependencyGapErrors", () => {
  it("allows known gaps but still flags unallowlisted ones", () => {
    expect(
      collectBundledExtensionRootDependencyGapErrors({
        rootPackage: { dependencies: {} },
        extensions: [
          {
            id: "googlechat",
            packageJson: {
              dependencies: { "google-auth-library": "^1.0.0" },
              openclaw: {
                install: { npmSpec: "@openclaw/googlechat" },
                releaseChecks: {
                  rootDependencyMirrorAllowlist: ["google-auth-library"],
                },
              },
            },
          },
          {
            id: "feishu",
            packageJson: {
              dependencies: { "@larksuiteoapi/node-sdk": "^1.59.0" },
              openclaw: { install: { npmSpec: "@openclaw/feishu" } },
            },
          },
        ],
      }),
    ).toEqual([
      "bundled extension 'feishu' root dependency mirror drift | missing in root package: @larksuiteoapi/node-sdk | new gaps: @larksuiteoapi/node-sdk",
    ]);
  });

  it("flags newly introduced bundled extension dependency gaps", () => {
    expect(
      collectBundledExtensionRootDependencyGapErrors({
        rootPackage: { dependencies: {} },
        extensions: [
          {
            id: "googlechat",
            packageJson: {
              dependencies: { "google-auth-library": "^1.0.0", undici: "^7.0.0" },
              openclaw: {
                install: { npmSpec: "@openclaw/googlechat" },
                releaseChecks: {
                  rootDependencyMirrorAllowlist: ["google-auth-library"],
                },
              },
            },
          },
        ],
      }),
    ).toEqual([
      "bundled extension 'googlechat' root dependency mirror drift | missing in root package: google-auth-library, undici | new gaps: undici",
    ]);
  });

  it("flags stale allowlist entries once a gap is resolved", () => {
    expect(
      collectBundledExtensionRootDependencyGapErrors({
        rootPackage: { dependencies: { "google-auth-library": "^1.0.0" } },
        extensions: [
          {
            id: "googlechat",
            packageJson: {
              dependencies: { "google-auth-library": "^1.0.0" },
              openclaw: {
                install: { npmSpec: "@openclaw/googlechat" },
                releaseChecks: {
                  rootDependencyMirrorAllowlist: ["google-auth-library"],
                },
              },
            },
          },
        ],
      }),
    ).toEqual([
      "bundled extension 'googlechat' root dependency mirror drift | missing in root package: (none) | remove stale allowlist entries: google-auth-library",
    ]);
  });
});
