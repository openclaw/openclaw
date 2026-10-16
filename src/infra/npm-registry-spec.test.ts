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
  it.each(["@openclaw/voice-call@1.2.3"])("accepts %s", (spec) => {
    expect(validateRegistryNpmSpec(spec)).toBeNull();
  });

  it.each([
    ["@openclaw/voice-call@^1.2.3", "exact version or dist-tag"],
    ["https://npmjs.org/pkg.tgz", "URLs are not allowed"],
    ["@openclaw/voice-call@", "missing version/tag after @"],
    ["@openclaw/voice-call@../beta", "invalid version/tag"],
  ])("rejects %s", (spec, expected) => {
    expect(validateRegistryNpmSpec(spec)).toContain(expected);
  });
});

describe("npm registry spec parsing helpers", () => {
  it.each([["v1.2.3", true]])("detects exact semver versions for %s", (value, expected) => {
    expect(isExactSemverVersion(value)).toBe(expected);
  });

  it.each([["2026.5.3-beta.1", true]])(
    "detects prerelease semver versions for %s",
    (value, expected) => {
      expect(isPrereleaseSemverVersion(value)).toBe(expected);
    },
  );

  it.each([["2026.5.3-0", "2026.5.3", null]])(
    "compares OpenClaw release versions for %s and %s",
    (left, right, expected) => {
      expect(compareOpenClawReleaseVersions(left, right)).toBe(expected);
    },
  );

  it.each([
    [" 2026.7.1-1 ", "2026.7.1"],
    ["2026.7.1-beta.3", "2026.7.1-beta.3"],
  ])("resolves the OpenClaw release cohort for %s", (version, expected) => {
    expect(resolveOpenClawReleaseCohortVersion(version)).toBe(expected);
  });
});

describe("npm prerelease resolution policy", () => {
  it.each([
    ["@openclaw/voice-call", "1.2.3-beta.1", false],
    ["@openclaw/voice-call@latest", "1.2.3-rc.1", false],
    ["@openclaw/voice-call@latest", "2026.5.3-1", true],
    ["@openclaw/voice-call@1.2.3-beta.1", "1.2.3-beta.1", true],
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
  it("unwraps scoped name keys in the npm 12 pack object", () => {
    const entry = { id: "@openclaw/voice-call@1.2.3", name: "@openclaw/voice-call" };
    expect(resolveNpmJsonEntries({ "@openclaw/voice-call": entry })).toEqual([entry]);
  });
});
