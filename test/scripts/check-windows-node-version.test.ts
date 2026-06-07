// Check Windows Node Version tests cover release metadata parsing and lag classification.
import { describe, expect, it } from "vitest";
import {
  classifyVersionLag,
  compareWindowsNodeVersions,
  parseBundledVersionFromReleaseBody,
  parseSemverFromTag,
  parseX64HashFromReleaseBody,
  parseX64HashFromSha256Manifest,
  resolveBundledWindowsNodeVersion,
} from "../../scripts/lib/windows-node-version-check.ts";

const V202661_RELEASE_BODY_SNIPPET = `
- Windows Hub x64 installer: https://github.com/openclaw/openclaw/releases/download/v2026.6.1/OpenClawCompanion-Setup-x64.exe
- Windows Hub SHA-256 manifest: https://github.com/openclaw/openclaw/releases/download/v2026.6.1/OpenClawCompanion-SHA256SUMS.txt
- Windows Hub source release: https://github.com/openclaw/openclaw-windows-node/releases/tag/v0.6.0
- Windows Hub x64 SHA-256: \`595a78a223f771adbaead34d56b190f5be5f97222d7707f8013ff4cc81d26983\`
`;

const V202661_SHA256_MANIFEST = `cb33a5f802f5790b2ac25bcb12cc3c6cc98ef5fa9fa8af5f0133f2b47cfcb88a  OpenClawCompanion-Setup-arm64.exe
595a78a223f771adbaead34d56b190f5be5f97222d7707f8013ff4cc81d26983  OpenClawCompanion-Setup-x64.exe
`;

describe("parseSemverFromTag", () => {
  it("parses release tags with or without v prefix", () => {
    expect(parseSemverFromTag("v0.6.3")).toBe("0.6.3");
    expect(parseSemverFromTag("0.6.3")).toBe("0.6.3");
  });
});

describe("parseBundledVersionFromReleaseBody", () => {
  it("reads the Windows Hub source release URL marker", () => {
    expect(parseBundledVersionFromReleaseBody(V202661_RELEASE_BODY_SNIPPET)).toBe("0.6.0");
  });

  it("reads the legacy openclaw-windows-node@ marker", () => {
    expect(parseBundledVersionFromReleaseBody("Source: openclaw-windows-node@v0.6.3")).toBe(
      "0.6.3",
    );
  });
});

describe("parseX64HashFromSha256Manifest", () => {
  it("extracts the x64 installer hash from the manifest", () => {
    expect(parseX64HashFromSha256Manifest(V202661_SHA256_MANIFEST)).toBe(
      "595a78a223f771adbaead34d56b190f5be5f97222d7707f8013ff4cc81d26983",
    );
  });
});

describe("parseX64HashFromReleaseBody", () => {
  it("extracts the x64 hash marker from release notes", () => {
    expect(parseX64HashFromReleaseBody(V202661_RELEASE_BODY_SNIPPET)).toBe(
      "595a78a223f771adbaead34d56b190f5be5f97222d7707f8013ff4cc81d26983",
    );
  });
});

describe("compareWindowsNodeVersions", () => {
  it("detects the issue 90953 lag scenario", () => {
    const lag = compareWindowsNodeVersions("0.6.0", "0.6.3");
    expect(lag).toBe(3);
    expect(lag).toBeGreaterThan(2);
  });
});

describe("classifyVersionLag", () => {
  it("treats small patch lag as acceptable by default", () => {
    expect(classifyVersionLag(2, 2)).toBe("acceptable");
    expect(classifyVersionLag(3, 2)).toBe("patch-lag");
  });
});

describe("resolveBundledWindowsNodeVersion", () => {
  it("prefers digest-inferred version over stale release-body metadata", () => {
    const resolved = resolveBundledWindowsNodeVersion({
      releaseBody: V202661_RELEASE_BODY_SNIPPET,
      sha256Manifest: V202661_SHA256_MANIFEST,
      digestInferredVersion: "0.6.3",
    });

    expect(resolved.version).toBe("0.6.3");
    expect(resolved.source).toBe("digest");
    expect(resolved.bodyDeclaredVersion).toBe("0.6.0");
    expect(resolved.metadataDrift).toBe(true);
  });

  it("falls back to the release-body source URL when digest lookup is unavailable", () => {
    const resolved = resolveBundledWindowsNodeVersion({
      releaseBody: V202661_RELEASE_BODY_SNIPPET,
      sha256Manifest: V202661_SHA256_MANIFEST,
    });

    expect(resolved.version).toBe("0.6.0");
    expect(resolved.source).toBe("release-body-url");
    expect(resolved.x64Hash).toBe(
      "595a78a223f771adbaead34d56b190f5be5f97222d7707f8013ff4cc81d26983",
    );
  });
});
