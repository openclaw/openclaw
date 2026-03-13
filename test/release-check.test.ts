import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectAppcastSparkleVersionErrors,
  collectBundledExtensionManifestErrors,
  collectBundledExtensionRootDependencyGapErrors,
  collectSkillShellScriptExecutableErrors,
  collectForbiddenPackPaths,
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

describe("collectBundledExtensionManifestErrors", () => {
  it("flags invalid bundled extension install metadata", () => {
    expect(
      collectBundledExtensionManifestErrors([
        {
          id: "broken",
          packageJson: {
            openclaw: {
              install: { npmSpec: "   " },
            },
          },
        },
      ]),
    ).toEqual([
      "bundled extension 'broken' manifest invalid | openclaw.install.npmSpec must be a non-empty string",
    ]);
  });

  it("flags invalid release-check allowlist metadata", () => {
    expect(
      collectBundledExtensionManifestErrors([
        {
          id: "broken",
          packageJson: {
            openclaw: {
              install: { npmSpec: "@openclaw/broken" },
              releaseChecks: {
                rootDependencyMirrorAllowlist: ["ok", ""],
              },
            },
          },
        },
      ]),
    ).toEqual([
      "bundled extension 'broken' manifest invalid | openclaw.releaseChecks.rootDependencyMirrorAllowlist must contain only non-empty strings",
    ]);
  });
});

// This suite exists both as regression coverage and as an intentional CI touchpoint for executable-bit fixes.
// Windows doesn't support Unix permission bits — chmod 0o755 is a no-op and
// statSync().mode never reports execute bits, so these tests are meaningless there.
describe.skipIf(process.platform === "win32")("collectSkillShellScriptExecutableErrors", () => {
  it("flags non-executable shell scripts under skills/*/scripts", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-release-check-"));
    const scriptPath = join(root, "skills", "openai-whisper-api", "scripts", "transcribe.sh");
    mkdirSync(join(root, "skills", "openai-whisper-api", "scripts"), { recursive: true });
    writeFileSync(scriptPath, "#!/usr/bin/env bash\necho test\n", "utf8");
    chmodSync(scriptPath, 0o644);

    try {
      expect(collectSkillShellScriptExecutableErrors(root)).toEqual([
        "skill shell script is not executable: skills/openai-whisper-api/scripts/transcribe.sh",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts executable shell scripts", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-release-check-"));
    const scriptPath = join(root, "skills", "openai-whisper-api", "scripts", "transcribe.sh");
    mkdirSync(join(root, "skills", "openai-whisper-api", "scripts"), { recursive: true });
    writeFileSync(scriptPath, "#!/usr/bin/env bash\necho test\n", "utf8");
    chmodSync(scriptPath, 0o755);

    try {
      expect(collectSkillShellScriptExecutableErrors(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
describe("collectForbiddenPackPaths", () => {
  it("flags nested node_modules leaking into npm pack output", () => {
    expect(
      collectForbiddenPackPaths([
        "dist/index.js",
        "extensions/tlon/node_modules/.bin/tlon",
        "node_modules/.bin/openclaw",
      ]),
    ).toEqual(["extensions/tlon/node_modules/.bin/tlon", "node_modules/.bin/openclaw"]);
  });
});
