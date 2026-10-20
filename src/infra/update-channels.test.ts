// Covers update channel and npm tag normalization.
import { describe, expect, it } from "vitest";
import {
  channelToNpmTag,
  isStableTag,
  normalizeUpdateChannel,
  resolveEffectiveUpdateChannel,
  resolveRegistryUpdateChannel,
  resolveUpdateChannelDisplay,
  type UpdateChannel,
} from "./update-channels.js";

describe("update-channels tag detection", () => {
  it.each([["v2026.6.32-1", true]])("stable classification for %s", (tag, stable) => {
    expect(isStableTag(tag)).toBe(stable);
  });
});

describe("normalizeUpdateChannel", () => {
  it.each([[undefined, null]] satisfies Array<[string | null | undefined, UpdateChannel | null]>)(
    "normalizes %j",
    (value, expected) => {
      expect(normalizeUpdateChannel(value)).toBe(expected);
    },
  );
});

describe("channelToNpmTag", () => {
  it.each([
    ["stable", "latest"],
    ["dev", "dev"],
  ] satisfies Array<[UpdateChannel, string]>)("maps %s to %s", (channel, expected) => {
    expect(channelToNpmTag(channel)).toBe(expected);
  });
});

describe("resolveEffectiveUpdateChannel", () => {
  it.each([
    {
      name: "uses main for immutable generations independently of the package version",
      params: {
        currentVersion: "2026.5.2-beta.1",
        installKind: "immutable" as const,
      },
      expected: { channel: "dev", source: "default" },
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
      name: "identifies final extended-stable git tags without enabling Git updates",
      params: { installKind: "git" as const, git: { tag: "v2026.6.33" } },
      expected: { channel: "extended-stable", source: "git-tag" },
    },
    {
      name: "treats non-beta prerelease git tag as dev",
      params: { installKind: "git" as const, git: { tag: "v2026.5.25-alpha.1" } },
      expected: { channel: "dev", source: "git-tag" },
    },
  ])("$name", ({ params, expected }) => {
    expect(resolveEffectiveUpdateChannel(params)).toEqual(expected);
  });
});

describe("resolveUpdateChannelDisplay labels", () => {
  it.each([
    {
      name: "formats git tag labels with tag",
      params: {
        installKind: "git",
        gitTag: "v2026.2.24",
      },
      expected: "stable (v2026.2.24)",
    },
    {
      name: "formats installed-version labels",
      params: { currentVersion: "2026.5.2-beta.1", installKind: "package" },
      expected: "beta (installed version)",
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
  it.each([["2026.6.33", "stable"]] as const)(
    "does not infer a package-only channel for %s",
    (currentVersion, expected) => {
      expect(resolveRegistryUpdateChannel({ currentVersion })).toBe(expected);
    },
  );

  it("queries beta when the installed version is beta even if config is stale stable", () => {
    expect(
      resolveRegistryUpdateChannel({
        configChannel: "stable",
        currentVersion: "2026.5.2-beta.1",
      }),
    ).toBe("beta");
  });
});
