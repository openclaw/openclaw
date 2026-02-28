import { describe, expect, it } from "vitest";
import { stripSenderPrefix } from "./elevated-allowlist-matcher.js";

describe("stripSenderPrefix", () => {
  it("strips prefix from sender value", () => {
    expect(stripSenderPrefix("prefix:value")).toBe("value");
  });
});
