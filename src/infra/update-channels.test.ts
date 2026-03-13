import { describe, expect, it } from "vitest";
import {
  channelToNpmTag,
  formatUpdateChannelLabel,
  isBetaTag,
  isStableTag,
  normalizeUpdateChannel,
  resolveEffectiveUpdateChannel,
  resolveUpdateChannelDisplay,
} from "./update-channels.js";

describe("update-channels tag detection", () => {
  it.each([
    { tag: "v2026.2.24-beta.1", beta: true },
    { tag: "v2026.2.24.beta.1", beta: true },
    { tag: "v2026.2.24-BETA-1", beta: true },
    { tag: "v2026.2.24-1", beta: false },
    { tag: "v2026.2.24-alphabeta.1", beta: false },
    { tag: "v2026.2.24", beta: false },
  ])("classifies $tag", ({ tag, beta }) => {
    expect(isBetaTag(tag)).toBe(beta);
    expect(isStableTag(tag)).toBe(!beta);
  });
});

describe("normalizeUpdateChannel", () => {
  it.each([
    { value: "stable", expected: "stable" },
    { value: " BETA ", expected: "beta" },
    { value: "Dev", expected: "dev" },
    { value: "", expected: null },
    { value: " nightly ", expected: null },
    { value: null, expected: null },
    { value: undefined, expected: null },
  ])("normalizes %j", ({ value, expected }) => {
    expect(normalizeUpdateChannel(value)).toBe(expected);
  });
});

describe("channelToNpmTag", () => {
  it.each([
    { channel: "stable", expected: "latest" },
    { channel: "beta", expected: "beta" },
    { channel: "dev", expected: "dev" },
  ])("maps $channel to $expected", ({ channel, expected }) => {
    expect(channelToNpmTag(channel)).toBe(expected);
  });
});

describe("resolveEffectiveUpdateChannel", () => {
  it.each([
    {
      name: "prefers config over git metadata",
      params: {
        configChannel: "beta",
        installKind: "git" as const,
        git: { tag: "v2026.2.24", branch: "feature/test" },
      },
      expected: { channel: "beta", source: "config" },
    },
    {
      name: "uses beta git tag",
      params: {
        installKind: "git" as const,
        git: { tag: "v2026.2.24-beta.1" },
      },
      expected: { channel: "beta", source: "git-tag" },
    },
    {
      name: "treats non-beta git tag as stable",
      params: {
        installKind: "git" as const,
        git: { tag: "v2026.2.24-1" },
      },
      expected: { channel: "stable", source: "git-tag" },
    },
    {
      name: "uses non-HEAD git branch as dev",
      params: {
        installKind: "git" as const,
        git: { branch: "feature/test" },
      },
      expected: { channel: "dev", source: "git-branch" },
    },
    {
      name: "falls back for detached HEAD git installs",
      params: {
        installKind: "git" as const,
        git: { branch: "HEAD" },
      },
      expected: { channel: "dev", source: "default" },
    },
    {
      name: "defaults package installs to stable",
      params: { installKind: "package" as const },
      expected: { channel: "stable", source: "default" },
    },
    {
      name: "defaults unknown installs to stable",
      params: { installKind: "unknown" as const },
      expected: { channel: "stable", source: "default" },
    },
  ])("$name", ({ params, expected }) => {
    expect(resolveEffectiveUpdateChannel(params)).toEqual(expected);
  });
});

describe("formatUpdateChannelLabel", () => {
  it.each([
    {
      name: "formats config labels",
      params: { channel: "beta", source: "config" as const },
      expected: "beta (config)",
    },
    {
      name: "formats git tag labels with tag",
      params: {
        channel: "stable",
        source: "git-tag" as const,
        gitTag: "v2026.2.24",
      },
      expected: "stable (v2026.2.24)",
    },
    {
      name: "formats git tag labels without tag",
      params: { channel: "stable", source: "git-tag" as const },
      expected: "stable (tag)",
    },
    {
      name: "formats git branch labels with branch",
      params: {
        channel: "dev",
        source: "git-branch" as const,
        gitBranch: "feature/test",
      },
      expected: "dev (feature/test)",
    },
    {
      name: "formats git branch labels without branch",
      params: { channel: "dev", source: "git-branch" as const },
      expected: "dev (branch)",
    },
    {
      name: "formats default labels",
      params: { channel: "stable", source: "default" as const },
      expected: "stable (default)",
    },
  ])("$name", ({ params, expected }) => {
    expect(formatUpdateChannelLabel(params)).toBe(expected);
  });
});

describe("resolveUpdateChannelDisplay", () => {
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
