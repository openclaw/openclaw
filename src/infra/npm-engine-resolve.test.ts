import { describe, expect, it } from "vitest";
import { formatEngineIncompatibleError, resolveFromVersionEntries } from "./npm-engine-resolve.js";
import type { NpmVersionEntry } from "./npm-registry-versions.js";

const CORE_VERSION = "2026.3.14";

function makeVersions(entries: Array<{ version: string; openclaw?: string }>): NpmVersionEntry[] {
  return entries.map((e) => ({
    version: e.version,
    ...(e.openclaw ? { engines: { openclaw: e.openclaw } } : {}),
  }));
}

describe("resolveFromVersionEntries", () => {
  it("returns latest compatible version", () => {
    const versions = makeVersions([
      { version: "2026.3.14", openclaw: ">=2026.3.14" },
      { version: "2026.3.12", openclaw: ">=2026.3.10" },
      { version: "2026.3.10", openclaw: ">=2026.3.10" },
    ]);

    const result = resolveFromVersionEntries({
      versions,
      coreVersion: CORE_VERSION,
      allowPrerelease: false,
    });

    expect(result.ok).toBe(true);
    expect(result.version).toBe("2026.3.14");
  });

  it("skips incompatible latest and returns older compatible version", () => {
    const versions = makeVersions([
      { version: "2027.1.0", openclaw: ">=2027.0.0" },
      { version: "2026.3.14", openclaw: ">=2026.3.10" },
      { version: "2026.3.12", openclaw: ">=2026.3.10" },
    ]);

    const result = resolveFromVersionEntries({
      versions,
      coreVersion: CORE_VERSION,
      allowPrerelease: false,
    });

    expect(result.ok).toBe(true);
    expect(result.version).toBe("2026.3.14");
  });

  it("treats versions without engines.openclaw as compatible", () => {
    const versions = makeVersions([
      { version: "2026.3.14" }, // no engines field
      { version: "2026.3.12", openclaw: ">=2026.3.10" },
    ]);

    const result = resolveFromVersionEntries({
      versions,
      coreVersion: CORE_VERSION,
      allowPrerelease: false,
    });

    expect(result.ok).toBe(true);
    expect(result.version).toBe("2026.3.14");
  });

  it("returns null when no compatible version exists", () => {
    const versions = makeVersions([
      { version: "2027.1.0", openclaw: ">=2027.0.0" },
      { version: "2027.0.0", openclaw: ">=2027.0.0" },
    ]);

    const result = resolveFromVersionEntries({
      versions,
      coreVersion: CORE_VERSION,
      allowPrerelease: false,
    });

    expect(result.ok).toBe(true);
    expect(result.version).toBeNull();
    if (result.version !== null) {
      return;
    }
    expect(result.latestVersion).toBe("2027.1.0");
    expect(result.latestRange).toBe(">=2027.0.0");
  });

  it("excludes prereleases by default", () => {
    const versions = makeVersions([
      { version: "2026.3.15-beta.1", openclaw: ">=2026.3.10" },
      { version: "2026.3.12", openclaw: ">=2026.3.10" },
    ]);

    const result = resolveFromVersionEntries({
      versions,
      coreVersion: CORE_VERSION,
      allowPrerelease: false,
    });

    expect(result.ok).toBe(true);
    expect(result.version).toBe("2026.3.12");
  });

  it("includes prereleases when allowPrerelease is true", () => {
    const versions = makeVersions([
      { version: "2026.3.15-beta.1", openclaw: ">=2026.3.10" },
      { version: "2026.3.12", openclaw: ">=2026.3.10" },
    ]);

    const result = resolveFromVersionEntries({
      versions,
      coreVersion: CORE_VERSION,
      allowPrerelease: true,
    });

    expect(result.ok).toBe(true);
    expect(result.version).toBe("2026.3.15-beta.1");
  });

  it("handles empty versions list", () => {
    const result = resolveFromVersionEntries({
      versions: [],
      coreVersion: CORE_VERSION,
      allowPrerelease: false,
    });

    expect(result.ok).toBe(true);
    expect(result.version).toBeNull();
  });

  it("supports caret range in engine constraint", () => {
    const versions = makeVersions([
      { version: "3.0.0", openclaw: "^2027.0.0" },
      { version: "2.0.0", openclaw: "^2026.3.0" },
      { version: "1.0.0", openclaw: "^2025.0.0" },
    ]);

    const result = resolveFromVersionEntries({
      versions,
      coreVersion: CORE_VERSION,
      allowPrerelease: false,
    });

    expect(result.ok).toBe(true);
    expect(result.version).toBe("2.0.0");
  });
});

describe("formatEngineIncompatibleError", () => {
  it("includes package name, core version, and advice", () => {
    const msg = formatEngineIncompatibleError({
      packageName: "@openclaw/memory-core",
      coreVersion: "2026.3.14",
      latestVersion: "2027.1.0",
      latestRange: ">=2027.0.0",
    });

    expect(msg).toContain("@openclaw/memory-core");
    expect(msg).toContain("2026.3.14");
    expect(msg).toContain("2027.1.0");
    expect(msg).toContain(">=2027.0.0");
    expect(msg).toContain("--ignore-engine");
  });

  it("works without latest version details", () => {
    const msg = formatEngineIncompatibleError({
      packageName: "some-plugin",
      coreVersion: "2026.3.14",
    });

    expect(msg).toContain("some-plugin");
    expect(msg).toContain("--ignore-engine");
  });
});
