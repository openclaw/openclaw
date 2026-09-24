// Tests npm registry spec parsing for packages, tags, and versions.
import { describe, expect, it } from "vitest";
import {
  compareOpenClawReleaseVersions,
  formatPrereleaseResolutionError,
  isExactSemverVersion,
  isPrereleaseSemverVersion,
  isPrereleaseResolutionAllowed,
  parseRegistryNpmSpec,
  resolveOpenClawReleaseCohortVersion,
  resolveNpmJsonEntries,
  validateRegistryNpmSpec,
} from "./npm-registry-spec.js";

function parseSpecOrThrow(spec: string) {
  const parsed = parseRegistryNpmSpec(spec);
  if (parsed === null) {
    throw new Error(`Expected ${spec} to parse`);
  }
  return parsed;
}

describe("npm registry spec validation", () => {
  it.each([
    "@openclaw/voice-call",
    "@openclaw/voice-call@1.2.3",
    "@openclaw/voice-call@1.2.3-beta.4",
    "@openclaw/voice-call@latest",
    "@openclaw/voice-call@beta",
  ])("accepts %s", (spec) => {
    expect(validateRegistryNpmSpec(spec)).toBeNull();
  });

  it.each([
    ["@openclaw/voice-call@^1.2.3", "exact version or dist-tag"],
    ["@openclaw/voice-call@~1.2.3", "exact version or dist-tag"],
    ["https://npmjs.org/pkg.tgz", "URLs are not allowed"],
    ["git+ssh://github.com/openclaw/openclaw", "URLs are not allowed"],
    ["@openclaw/voice-call@", "missing version/tag after @"],
    ["@openclaw/voice-call@../beta", "invalid version/tag"],
  ])("rejects %s", (spec, expected) => {
    expect(validateRegistryNpmSpec(spec)).toContain(expected);
  });
});

describe("npm registry spec parsing helpers", () => {
  it.each([
    [
      "@openclaw/voice-call",
      {
        name: "@openclaw/voice-call",
        raw: "@openclaw/voice-call",
        selectorKind: "none",
        selectorIsPrerelease: false,
      },
    ],
    [
      "@openclaw/voice-call@beta",
      {
        name: "@openclaw/voice-call",
        raw: "@openclaw/voice-call@beta",
        selector: "beta",
        selectorKind: "tag",
        selectorIsPrerelease: false,
      },
    ],
    [
      "@openclaw/voice-call@2026.5.3-1",
      {
        name: "@openclaw/voice-call",
        raw: "@openclaw/voice-call@2026.5.3-1",
        selector: "2026.5.3-1",
        selectorKind: "exact-version",
        selectorIsPrerelease: false,
      },
    ],
    [
      "@openclaw/voice-call@1.2.3-beta.1",
      {
        name: "@openclaw/voice-call",
        raw: "@openclaw/voice-call@1.2.3-beta.1",
        selector: "1.2.3-beta.1",
        selectorKind: "exact-version",
        selectorIsPrerelease: true,
      },
    ],
  ])("parses %s", (spec, expected) => {
    expect(parseRegistryNpmSpec(spec)).toEqual(expected);
  });

  it.each([
    ["v1.2.3", true],
    ["1.2", false],
  ])("detects exact semver versions for %s", (value, expected) => {
    expect(isExactSemverVersion(value)).toBe(expected);
  });

  it.each([
    ["1.2.3-beta.1", true],
    ["1.2.3-1", true],
    ["2026.5.3-beta.1", true],
    ["2026.5.3-1", false],
    ["2026.2.30-1", false],
    ["1.2.3", false],
  ])("detects prerelease semver versions for %s", (value, expected) => {
    expect(isPrereleaseSemverVersion(value)).toBe(expected);
  });

  it.each([
    ["2026.5.3-1", "2026.5.3", 1],
    ["2026.5.3-2", "2026.5.3-1", 1],
    ["2026.5.3", "2026.5.3-beta.3", 1],
    ["2026.5.3-beta.3", "2026.5.3-alpha.9", 1],
    ["2026.5.3-alpha.10", "2026.5.3-alpha.2", 1],
    ["2026.5.3-0", "2026.5.3", null],
    ["2026.5.3+build", "2026.5.3", null],
    ["1.2.3-1", "1.2.3", null],
  ])("compares OpenClaw release versions for %s and %s", (left, right, expected) => {
    expect(compareOpenClawReleaseVersions(left, right)).toBe(expected);
  });

  it.each([
    ["2026.7.1-2", "2026.7.1"],
    [" 2026.7.1-1 ", "2026.7.1"],
    ["2026.7.1", "2026.7.1"],
    ["2026.7.1-beta.3", "2026.7.1-beta.3"],
    ["1.2.3-1", "1.2.3-1"],
  ])("resolves the OpenClaw release cohort for %s", (version, expected) => {
    expect(resolveOpenClawReleaseCohortVersion(version)).toBe(expected);
  });
});

describe("npm prerelease resolution policy", () => {
  it.each([
    ["@openclaw/voice-call", "1.2.3-beta.1", false],
    ["@openclaw/voice-call@latest", "1.2.3-rc.1", false],
    ["@openclaw/voice-call@latest", "2026.5.3-1", true],
    ["@openclaw/voice-call@beta", "1.2.3-beta.4", true],
    ["@openclaw/voice-call@1.2.3-beta.1", "1.2.3-beta.1", true],
    ["@openclaw/voice-call", "1.2.3", true],
    ["@openclaw/voice-call@latest", undefined, true],
  ])("decides prerelease resolution for %s -> %s", (spec, resolvedVersion, expected) => {
    expect(
      isPrereleaseResolutionAllowed({
        spec: parseSpecOrThrow(spec),
        resolvedVersion,
      }),
    ).toBe(expected);
  });

  it.each([
    ["@openclaw/voice-call", "1.2.3-beta.1", `Use "@openclaw/voice-call@beta"`],
    [
      "@openclaw/voice-call@beta",
      "1.2.3-rc.1",
      "Use an explicit prerelease tag or exact prerelease version",
    ],
  ])("formats prerelease guidance for %s", (spec, resolvedVersion, expected) => {
    expect(
      formatPrereleaseResolutionError({
        spec: parseSpecOrThrow(spec),
        resolvedVersion,
      }),
    ).toContain(expected);
  });
});

describe("resolveNpmJsonEntries", () => {
  it("passes entry arrays through (npm <=11 pack shape)", () => {
    const entries = [{ name: "openclaw", version: "2026.7.1", filename: "openclaw-2026.7.1.tgz" }];
    expect(resolveNpmJsonEntries(entries)).toBe(entries);
  });

  it("keeps a bare entry object as a single entry (npm <=11 view shape)", () => {
    const entry = { name: "openclaw", version: "2026.7.1", "dist.integrity": "sha512-x" };
    expect(resolveNpmJsonEntries(entry)).toEqual([entry]);
  });

  it("unwraps the npm 12 singleton view array", () => {
    const entry = { name: "openclaw", version: "2026.7.1", "dist.integrity": "sha512-x" };
    expect(resolveNpmJsonEntries([entry])).toEqual([entry]);
  });

  it("unwraps the npm 12 name-keyed pack object", () => {
    const entry = {
      id: "openclaw@2026.7.1",
      name: "openclaw",
      version: "2026.7.1",
      filename: "openclaw-2026.7.1.tgz",
    };
    expect(resolveNpmJsonEntries({ openclaw: entry })).toEqual([entry]);
  });

  it("unwraps scoped name keys in the npm 12 pack object", () => {
    const entry = { id: "@openclaw/voice-call@1.2.3", name: "@openclaw/voice-call" };
    expect(resolveNpmJsonEntries({ "@openclaw/voice-call": entry })).toEqual([entry]);
  });

  it("falls back to the raw value when no entries are recognizable", () => {
    expect(resolveNpmJsonEntries("not-json-shaped")).toEqual(["not-json-shaped"]);
    expect(resolveNpmJsonEntries(null)).toEqual([null]);
  });
});
