import { describe, expect, it } from "vitest";
import { normalizeSlackIconEmoji } from "./send.js";

describe("normalizeSlackIconEmoji", () => {
  it("returns undefined for falsy input", () => {
    expect(normalizeSlackIconEmoji(undefined)).toBeUndefined();
    expect(normalizeSlackIconEmoji(null)).toBeUndefined();
    expect(normalizeSlackIconEmoji("")).toBeUndefined();
    expect(normalizeSlackIconEmoji("   ")).toBeUndefined();
  });

  it("passes through already-wrapped emoji", () => {
    expect(normalizeSlackIconEmoji(":robot_face:")).toBe(":robot_face:");
    expect(normalizeSlackIconEmoji(":stitch-1:")).toBe(":stitch-1:");
  });

  it("wraps bare emoji name with colons", () => {
    expect(normalizeSlackIconEmoji("robot_face")).toBe(":robot_face:");
    expect(normalizeSlackIconEmoji("stitch-1")).toBe(":stitch-1:");
  });

  it("strips stray leading/trailing colons before wrapping", () => {
    expect(normalizeSlackIconEmoji(":robot_face")).toBe(":robot_face:");
    expect(normalizeSlackIconEmoji("robot_face:")).toBe(":robot_face:");
    expect(normalizeSlackIconEmoji("::robot_face::")).toBe(":robot_face:");
  });

  it("trims whitespace", () => {
    expect(normalizeSlackIconEmoji("  :fire:  ")).toBe(":fire:");
    expect(normalizeSlackIconEmoji("  fire  ")).toBe(":fire:");
  });

  it("returns undefined for names containing spaces", () => {
    expect(normalizeSlackIconEmoji("not valid")).toBeUndefined();
  });
});
