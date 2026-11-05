import { expect, it } from "vitest";
import {
  channelToNpmTag,
  isStableTag,
  normalizeUpdateChannel,
  resolveEffectiveUpdateChannel,
  resolveRegistryUpdateChannel,
  resolveUpdateChannelDisplay,
  type UpdateChannel,
} from "./update-channels.js";

it("classifies numbered stable corrections", () => {
  expect(isStableTag("v2026.6.32-1")).toBe(true);
});

it("normalizes an absent channel", () => {
  expect(normalizeUpdateChannel(undefined)).toBe(null);
});

it.each([
  ["stable", "latest"],
  ["dev", "dev"],
] satisfies Array<[UpdateChannel, string]>)("maps %s to %s", (channel, expected) => {
  expect(channelToNpmTag(channel)).toBe(expected);
});

it.each([
  [{ currentVersion: "2026.5.2-beta.1", installKind: "immutable" }, "dev", "default"],
  [{ currentVersion: "2026.6.33", installKind: "package" }, "extended-stable", "installed-version"],
  [{ installKind: "git", git: { tag: "v2026.6.33" } }, "extended-stable", "git-tag"],
  [{ installKind: "git", git: { tag: "v2026.5.25-alpha.1" } }, "dev", "git-tag"],
] satisfies Array<[Parameters<typeof resolveEffectiveUpdateChannel>[0], UpdateChannel, string]>)(
  "resolves effective channel for %j",
  (params, channel, source) => {
    expect(resolveEffectiveUpdateChannel(params)).toEqual({ channel, source });
  },
);

it.each([
  [{ installKind: "git", gitTag: "v2026.2.24" }, "stable (v2026.2.24)"],
  [{ currentVersion: "2026.5.2-beta.1", installKind: "package" }, "beta (installed version)"],
  [
    { configChannel: "stable", currentVersion: "2026.5.2-beta.1", installKind: "package" },
    { channel: "stable", source: "config", label: "stable (config)" },
  ],
  [
    { installKind: "git", gitBranch: "feature/test" },
    { channel: "dev", source: "git-branch", label: "dev (feature/test)" },
  ],
  [
    { installKind: "git", gitTag: "v2026.2.24-beta.1", gitBranch: "feature/test" },
    { channel: "beta", source: "git-tag", label: "beta (v2026.2.24-beta.1)" },
  ],
  [{ installKind: "package" }, { channel: "stable", source: "default", label: "stable (default)" }],
] satisfies Array<
  [
    Parameters<typeof resolveUpdateChannelDisplay>[0],
    string | ReturnType<typeof resolveUpdateChannelDisplay>,
  ]
>)("resolves display metadata for %j", (params, expected) => {
  const actual = resolveUpdateChannelDisplay(params);
  if (typeof expected === "string") {
    expect(actual.label).toBe(expected);
  } else {
    expect(actual).toEqual(expected);
  }
});

it.each([
  [{ currentVersion: "2026.6.33" }, "stable"],
  [{ configChannel: "stable", currentVersion: "2026.5.2-beta.1" }, "beta"],
] satisfies Array<[Parameters<typeof resolveRegistryUpdateChannel>[0], UpdateChannel]>)(
  "resolves registry channel for %j",
  (params, expected) => {
    expect(resolveRegistryUpdateChannel(params)).toBe(expected);
  },
);
