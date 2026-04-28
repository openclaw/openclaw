import { describe, expect, it } from "vitest";
import { resolveLiveVideoSkipReason } from "./live-video-skip-reason.js";

describe("resolveLiveVideoSkipReason", () => {
  it("classifies provider policy moderation blocks as skip-worthy drift", () => {
    expect(resolveLiveVideoSkipReason("Your request was blocked by our moderation system.")).toBe(
      "provider policy drift",
    );
  });

  it("does not hide ordinary provider failures", () => {
    expect(resolveLiveVideoSkipReason("video generation returned an empty asset")).toBeNull();
  });
});
