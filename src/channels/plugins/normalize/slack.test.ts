import { describe, expect, it } from "vitest";
import { looksLikeSlackTargetId, normalizeSlackMessagingTarget } from "./slack.js";

describe("looksLikeSlackTargetId", () => {
  it("returns true for valid channel IDs", () => {
    expect(looksLikeSlackTargetId("C12345678")).toBe(true);
    expect(looksLikeSlackTargetId("C1234567890")).toBe(true);
    expect(looksLikeSlackTargetId("channel:C12345678")).toBe(true);
  });

  it("returns true for valid user IDs", () => {
    expect(looksLikeSlackTargetId("U12345678")).toBe(true);
    expect(looksLikeSlackTargetId("W12345678")).toBe(true);
    expect(looksLikeSlackTargetId("user:U12345678")).toBe(true);
    expect(looksLikeSlackTargetId("<@U12345678>")).toBe(true);
  });

  it("returns true for # prefixed valid channel IDs", () => {
    expect(looksLikeSlackTargetId("#C12345678")).toBe(true);
    expect(looksLikeSlackTargetId("#C1234567890")).toBe(true);
  });

  it("returns true for @ prefixed valid user IDs", () => {
    expect(looksLikeSlackTargetId("@U12345678")).toBe(true);
    expect(looksLikeSlackTargetId("@W12345678")).toBe(true);
  });

  it("returns false for channel NAMES (should use directory lookup)", () => {
    // These are channel names, not IDs - should be resolved via directory
    expect(looksLikeSlackTargetId("#general")).toBe(false);
    expect(looksLikeSlackTargetId("#main")).toBe(false);
    expect(looksLikeSlackTargetId("#random")).toBe(false);
    expect(looksLikeSlackTargetId("#voice-ki")).toBe(false);
  });

  it("returns false for user NAMES (should use directory lookup)", () => {
    // These are user names, not IDs - should be resolved via directory
    expect(looksLikeSlackTargetId("@john")).toBe(false);
    expect(looksLikeSlackTargetId("@sebastian")).toBe(false);
    expect(looksLikeSlackTargetId("@emma")).toBe(false);
  });

  it("returns false for empty/whitespace", () => {
    expect(looksLikeSlackTargetId("")).toBe(false);
    expect(looksLikeSlackTargetId("   ")).toBe(false);
  });

  it("returns true for slack: prefixed", () => {
    expect(looksLikeSlackTargetId("slack:U12345678")).toBe(true);
  });
});

describe("normalizeSlackMessagingTarget", () => {
  it("normalizes user IDs", () => {
    expect(normalizeSlackMessagingTarget("user:U12345678")).toBe("user:U12345678");
    expect(normalizeSlackMessagingTarget("<@U12345678>")).toBe("user:U12345678");
  });

  it("normalizes channel IDs", () => {
    expect(normalizeSlackMessagingTarget("channel:C12345678")).toBe("channel:C12345678");
  });
});
