import { describe, expect, it } from "vitest";
import {
  resolveCurrentDockerReleaseTags,
  resolveDockerReleasePolicy,
} from "../../scripts/lib/docker-release-policy.mjs";

describe("Docker release policy", () => {
  it("resolves the newest stable and extended-stable tags independently", () => {
    expect(
      resolveCurrentDockerReleaseTags([
        "v2026.6.34",
        "v2026.7.1-2",
        "v2026.6.33",
        "v2026.8.1-beta.1",
        "not-a-release-tag",
        "v2026.7.1",
      ]),
    ).toEqual({
      stable: { tag: "v2026.7.1-2", version: "2026.7.1-2" },
      extendedStable: { tag: "v2026.6.34", version: "2026.6.34" },
    });
  });

  it.each([
    [["v2026.6.34"], "No stable Docker release tag found"],
    [["v2026.7.1"], "No extended-stable Docker release tag found"],
  ])("requires both moving release channels when resolving refresh sources", (tags, error) => {
    expect(() => resolveCurrentDockerReleaseTags(tags)).toThrow(error);
  });

  it.each(["2026.6.33-1", "2026.6.33-alpha.1", "not-a-version"])(
    "rejects unsupported release version %s",
    (version) => {
      expect(() => resolveDockerReleasePolicy(version)).toThrow();
    },
  );
});
