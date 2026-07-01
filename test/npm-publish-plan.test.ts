// npm publish plan tests validate package publish planning rules.
import { describe, expect, it } from "vitest";
import {
  compareReleaseVersions,
  collectReleaseVersionFloorErrors,
  parseReleaseVersion,
  resolveNpmDistTagMirrorAuth,
  resolveNpmPublishPlan,
  shouldRequireNpmDistTagMirrorAuth,
} from "../scripts/lib/npm-publish-plan.mjs";

describe("release version compatibility", () => {
  it.each([
    ["2026.7.1-alpha.2", "alpha"],
    ["2026.7.1-beta.2", "beta"],
    ["2026.7.32", "daily"],
    ["2026.7.33", "stable-base"],
    ["2026.7.34", "stable-patch"],
    ["2026.7.34-2", "historical-correction"],
  ] as const)("adds releaseClass to %s as %s without changing channel", (version, releaseClass) => {
    expect(parseReleaseVersion(version)).toMatchObject({
      version,
      channel: releaseClass === "alpha" ? "alpha" : releaseClass === "beta" ? "beta" : "stable",
      releaseClass,
    });
  });

  it("keeps numeric cross-month ordering", () => {
    expect(compareReleaseVersions("2026.6.34", "2026.7.1")).toBe(-1);
  });

  it("keeps legacy publish plans unchanged across the daily/stable boundary", () => {
    expect(resolveNpmPublishPlan("2026.7.32")).toEqual({
      channel: "stable",
      publishTag: "latest",
      mirrorDistTags: ["beta"],
    });
    expect(resolveNpmPublishPlan("2026.7.33")).toEqual({
      channel: "stable",
      publishTag: "latest",
      mirrorDistTags: ["beta"],
    });
    expect(resolveNpmPublishPlan("2026.7.34")).toEqual({
      channel: "stable",
      publishTag: "latest",
      mirrorDistTags: ["beta"],
    });
  });
});

describe("collectReleaseVersionFloorErrors", () => {
  it("blocks June 2026 stable and beta release trains below the published beta floor", () => {
    expect(collectReleaseVersionFloorErrors("2026.6.4")).toEqual([
      'June 2026 stable and beta release trains must use patch 5 or higher because 2026.6.5-beta.1 is already published; found "2026.6.4".',
    ]);
    expect(collectReleaseVersionFloorErrors("2026.6.4-beta.1")).toEqual([
      'June 2026 stable and beta release trains must use patch 5 or higher because 2026.6.5-beta.1 is already published; found "2026.6.4-beta.1".',
    ]);
  });

  it("keeps alpha compatibility and patch-floor release trains valid during the transition", () => {
    expect(collectReleaseVersionFloorErrors("2026.6.4-alpha.1")).toEqual([]);
    expect(collectReleaseVersionFloorErrors("2026.6.5-beta.2")).toEqual([]);
    expect(collectReleaseVersionFloorErrors("2026.7.1")).toEqual([]);
  });
});

describe("shouldRequireNpmDistTagMirrorAuth", () => {
  it("does not require npm auth for dry-run preview commands", () => {
    const plan = resolveNpmPublishPlan("2026.4.1");
    const auth = resolveNpmDistTagMirrorAuth({});

    expect(
      shouldRequireNpmDistTagMirrorAuth({
        mode: "--dry-run",
        mirrorDistTags: plan.mirrorDistTags,
        hasAuth: auth.hasAuth,
      }),
    ).toBe(false);
  });

  it("requires npm auth for real publishes that mirror dist-tags", () => {
    const plan = resolveNpmPublishPlan("2026.4.1");
    const auth = resolveNpmDistTagMirrorAuth({});

    expect(
      shouldRequireNpmDistTagMirrorAuth({
        mode: "--publish",
        mirrorDistTags: plan.mirrorDistTags,
        hasAuth: auth.hasAuth,
      }),
    ).toBe(true);
  });

  it("treats stable correction releases as latest publishes with beta mirroring", () => {
    const plan = resolveNpmPublishPlan("2026.4.1-1");

    expect(plan).toEqual({
      channel: "stable",
      publishTag: "latest",
      mirrorDistTags: ["beta"],
    });
  });

  it("does not require auth when there are no mirror dist-tags", () => {
    const plan = resolveNpmPublishPlan("2026.4.1-beta.1");
    const auth = resolveNpmDistTagMirrorAuth({});

    expect(
      shouldRequireNpmDistTagMirrorAuth({
        mode: "--publish",
        mirrorDistTags: plan.mirrorDistTags,
        hasAuth: auth.hasAuth,
      }),
    ).toBe(false);
  });

  it("publishes alpha prereleases without dist-tag mirroring", () => {
    const plan = resolveNpmPublishPlan("2026.4.1-alpha.1");

    expect(plan).toEqual({
      channel: "alpha",
      publishTag: "alpha",
      mirrorDistTags: [],
    });
  });

  it("does not require auth when a publish already has npm auth", () => {
    const plan = resolveNpmPublishPlan("2026.4.1");
    const auth = resolveNpmDistTagMirrorAuth({ npmToken: "token" });

    expect(
      shouldRequireNpmDistTagMirrorAuth({
        mode: "--publish",
        mirrorDistTags: plan.mirrorDistTags,
        hasAuth: auth.hasAuth,
      }),
    ).toBe(false);
  });
});
