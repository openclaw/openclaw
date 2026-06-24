// Build-version skew tests lock the warn matrix for plugin artifacts vs the running host.
import { describe, expect, it } from "vitest";
import { checkPluginBuildVersionSkew } from "./build-version-skew.js";

describe("checkPluginBuildVersionSkew", () => {
  const cases: Array<{
    name: string;
    build: unknown;
    current: string | undefined;
    skew: boolean;
  }> = [
    { name: "missing build metadata", build: undefined, current: "2026.6.5", skew: false },
    { name: "blank build metadata", build: "  ", current: "2026.6.5", skew: false },
    { name: "non-string build metadata", build: 42, current: "2026.6.5", skew: false },
    { name: "unknown host version", build: "2026.6.5", current: undefined, skew: false },
    { name: "unparseable build version", build: "next", current: "2026.6.5", skew: false },
    { name: "exact match", build: "2026.6.5", current: "2026.6.5", skew: false },
    {
      name: "exact prerelease match",
      build: "2026.6.5-beta.5",
      current: "2026.6.5-beta.5",
      skew: false,
    },
    {
      name: "older stable build on newer host",
      build: "2026.6.4",
      current: "2026.6.5",
      skew: false,
    },
    {
      name: "older stable build on newer prerelease host",
      build: "2026.6.4",
      current: "2026.6.5-beta.2",
      skew: false,
    },
    {
      name: "build metadata suffix treated as stable",
      build: "2026.6.4+sha.abc",
      current: "2026.6.5",
      skew: false,
    },
    {
      name: "prerelease build on same-train stable host",
      build: "2026.6.5-beta.5",
      current: "2026.6.5",
      skew: true,
    },
    {
      name: "prerelease build on different prerelease host",
      build: "2026.6.5-beta.5",
      current: "2026.6.5-beta.6",
      skew: true,
    },
    {
      name: "prerelease build on older host",
      build: "2026.6.5-beta.5",
      current: "2026.6.4",
      skew: true,
    },
    { name: "stable build on older host", build: "2026.6.6", current: "2026.6.5", skew: true },
    {
      name: "stable build on same-train prerelease host",
      build: "2026.6.5",
      current: "2026.6.5-beta.6",
      skew: true,
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      const result = checkPluginBuildVersionSkew({
        currentVersion: testCase.current,
        buildOpenclawVersion: testCase.build,
      });
      if (testCase.skew) {
        expect(result).toEqual({
          buildVersion: testCase.build,
          currentVersion: testCase.current,
        });
      } else {
        expect(result).toBeNull();
      }
    });
  }
});
