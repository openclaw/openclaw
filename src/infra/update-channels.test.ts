// Covers update channel and npm tag normalization.
import { describe, expect, it } from "vitest";
import {
  channelToNpmTag,
  isBetaTag,
  isStableTag,
  normalizeUpdateChannel,
  resolveEffectiveUpdateChannel,
  resolveRegistryUpdateChannel,
  resolveUpdateChannelDisplay,
  type UpdateChannel,
} from "./update-channels.js";

describe("update-channels tag detection", () => {
  it.each([
    ["v2026.2.24-beta.1", true],
    ["v2026.2.24.beta.1", true],
    ["v2026.2.24-BETA-1", true],
    ["v2026.2.24-alpha.1", false],
    ["v2026.2.24-next.1", false],
    ["v2026.2.24-1", false],
    ["v2026.2.24-alphabeta.1", false],
    ["v2026.2.24", false],
  ])("classifies %s", (tag, beta) => {
    expect(isBetaTag(tag)).toBe(beta);
  });

  it.each([
    ["v2026.2.24-alpha.1", false],
    ["v2026.2.24-beta.1", false],
    ["v2026.2.24-rc.1", false],
    ["v2026.2.24-preview.1", false],
    ["v2026.2.24-custom.1", false],
    ["v2026.2.24-1", true],
    ["v1.0.1-1", true],
    ["v2026.2.24", true],
    ["v2026.6.32", true],
    ["v2026.6.32-1", true],
    ["v2026.6.33", false],
    ["2026.6.34", false],
    ["v2026.6.33-1", false],
    ["v2026.6.34+build.1", false],
    ["v2026.6.33-beta.1", false],
    ["v1.6.33", true],
  ])("stable classification for %s", (tag, stable) => {
    expect(isStableTag(tag)).toBe(stable);
  });
});

describe("normalizeUpdateChannel", () => {
  it.each([
    ["stable", "stable"],
    [" extended-stable ", "extended-stable"],
    [" BETA ", "beta"],
    ["Dev", "dev"],
    ["", null],
    ["daily", null],
    [" nightly ", null],
    [null, null],
    [undefined, null],
  ] satisfies Array<[string | null | undefined, UpdateChannel | null]>)(
    "normalizes %j",
    (value, expected) => {
      expect(normalizeUpdateChannel(value)).toBe(expected);
    },
  );
});

describe("channelToNpmTag", () => {
  it.each([
    ["stable", "latest"],
    ["extended-stable", "extended-stable"],
    ["beta", "beta"],
    ["dev", "dev"],
  ] satisfies Array<[UpdateChannel, string]>)("maps %s to %s", (channel, expected) => {
    expect(channelToNpmTag(channel)).toBe(expected);
  });
});

describe("resolveEffectiveUpdateChannel", () => {
  it.each([
    {
      name: "prefers config over git metadata",
      params: {
        configChannel: "beta" as const,
        installKind: "git" as const,
        git: { tag: "v2026.2.24", branch: "feature/test" },
      },
      expected: { channel: "beta", source: "config" },
    },
    {
      name: "keeps configured stable after a one-off beta package update",
      params: {
        configChannel: "stable" as const,
        currentVersion: "2026.5.2-beta.1",
        installKind: "package" as const,
      },
      expected: { channel: "stable", source: "config" },
    },
    {
      name: "uses installed beta version without a configured channel",
      params: {
        currentVersion: "2026.5.2-beta.1",
        installKind: "package" as const,
      },
      expected: { channel: "beta", source: "installed-version" },
    },
    {
      name: "keeps explicit extended-stable config",
      params: {
        configChannel: "extended-stable" as const,
        currentVersion: "2026.5.2-beta.1",
        installKind: "package" as const,
      },
      expected: { channel: "extended-stable", source: "config" },
    },
    {
      name: "uses installed extended-stable version without config",
      params: {
        currentVersion: "2026.6.33",
        installKind: "package" as const,
      },
      expected: { channel: "extended-stable", source: "installed-version" },
    },
    {
      name: "uses beta git tag",
      params: { installKind: "git" as const, git: { tag: "v2026.2.24-beta.1" } },
      expected: { channel: "beta", source: "git-tag" },
    },
    {
      name: "treats stable git tag as stable",
      params: { installKind: "git" as const, git: { tag: "v2026.2.24" } },
      expected: { channel: "stable", source: "git-tag" },
    },
    {
      name: "identifies final extended-stable git tags without enabling Git updates",
      params: { installKind: "git" as const, git: { tag: "v2026.6.33" } },
      expected: { channel: "extended-stable", source: "git-tag" },
    },
    {
      name: "preserves explicit stable policy on an extended-stable git tag",
      params: {
        configChannel: "stable" as const,
        installKind: "git" as const,
        git: { tag: "v2026.6.33" },
      },
      expected: { channel: "stable", source: "config" },
    },
    {
      name: "treats non-beta prerelease git tag as dev",
      params: { installKind: "git" as const, git: { tag: "v2026.5.25-alpha.1" } },
      expected: { channel: "dev", source: "git-tag" },
    },
    {
      name: "uses feature branch as dev",
      params: { installKind: "git" as const, git: { branch: "feature/test" } },
      expected: { channel: "dev", source: "git-branch" },
    },
    {
      name: "defaults package installs to stable",
      params: { installKind: "package" as const },
      expected: { channel: "stable", source: "default" },
    },
  ])("$name", ({ params, expected }) => {
    expect(resolveEffectiveUpdateChannel(params)).toEqual(expected);
  });
});

describe("resolveUpdateChannelDisplay labels", () => {
  it.each([
    {
      name: "formats config labels",
      params: { configChannel: "beta", installKind: "package" },
      expected: "beta (config)",
    },
    {
      name: "formats git tag labels with tag",
      params: {
        installKind: "git",
        gitTag: "v2026.2.24",
      },
      expected: "stable (v2026.2.24)",
    },
    {
      name: "formats git branch labels with branch",
      params: {
        installKind: "git",
        gitBranch: "feature/test",
      },
      expected: "dev (feature/test)",
    },
    {
      name: "formats installed-version labels",
      params: { currentVersion: "2026.5.2-beta.1", installKind: "package" },
      expected: "beta (installed version)",
    },
    {
      name: "formats default labels",
      params: { installKind: "package" },
      expected: "stable (default)",
    },
  ] satisfies Array<{
    name: string;
    params: Parameters<typeof resolveUpdateChannelDisplay>[0];
    expected: string;
  }>)("$name", ({ params, expected }) => {
    expect(resolveUpdateChannelDisplay(params).label).toBe(expected);
  });
});

describe("resolveUpdateChannelDisplay", () => {
  it("shows the configured stable channel after a one-off beta package update", () => {
    expect(
      resolveUpdateChannelDisplay({
        configChannel: "stable",
        currentVersion: "2026.5.2-beta.1",
        installKind: "package",
      }),
    ).toEqual({
      channel: "stable",
      source: "config",
      label: "stable (config)",
    });
  });

  it("includes the derived label for git branches", () => {
    expect(
      resolveUpdateChannelDisplay({
        installKind: "git",
        gitBranch: "feature/test",
      }),
    ).toEqual({
      channel: "dev",
      source: "git-branch",
      label: "dev (feature/test)",
    });
  });

  it("prefers git tag precedence over branch metadata in the derived label", () => {
    expect(
      resolveUpdateChannelDisplay({
        installKind: "git",
        gitTag: "v2026.2.24-beta.1",
        gitBranch: "feature/test",
      }),
    ).toEqual({
      channel: "beta",
      source: "git-tag",
      label: "beta (v2026.2.24-beta.1)",
    });
  });

  it("does not synthesize git metadata when both tag and branch are missing", () => {
    expect(
      resolveUpdateChannelDisplay({
        installKind: "package",
      }),
    ).toEqual({
      channel: "stable",
      source: "default",
      label: "stable (default)",
    });
  });
});

describe("resolveRegistryUpdateChannel", () => {
  it.each([
    ["2026.6.32", "stable"],
    ["2026.6.33", "stable"],
    ["2026.6.34", "stable"],
    ["2026.6.33-1", "stable"],
    ["1.33.1", "stable"],
    ["1.6.33", "stable"],
  ] as const)("does not infer a package-only channel for %s", (currentVersion, expected) => {
    expect(resolveRegistryUpdateChannel({ currentVersion })).toBe(expected);
  });

  it("queries beta when the installed version is beta even if config is stale stable", () => {
    expect(
      resolveRegistryUpdateChannel({
        configChannel: "stable",
        currentVersion: "2026.5.2-beta.1",
      }),
    ).toBe("beta");
  });

  it("keeps explicit extended-stable config on an installed beta version", () => {
    expect(
      resolveRegistryUpdateChannel({
        configChannel: "extended-stable",
        currentVersion: "2026.5.2-beta.1",
      }),
    ).toBe("extended-stable");
  });
});
