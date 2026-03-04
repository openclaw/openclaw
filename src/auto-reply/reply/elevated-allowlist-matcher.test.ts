import { describe, expect, it } from "vitest";
import { stripSenderPrefix } from "./elevated-allowlist-matcher.js";

describe("stripSenderPrefix", () => {
  it("strips prefix from sender value", () => {
    expect(stripSenderPrefix("tel:+12345")).toBe("+12345");
  });

  it("returns original value when no prefix", () => {
    expect(stripSenderPrefix("+12345")).toBe("+12345");
  });
});
