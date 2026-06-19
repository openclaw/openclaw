// Sender label tests cover display-label formatting for channel senders.
import { describe, expect, it } from "vitest";
import { resolveSenderLabel } from "./sender-label.js";

describe("resolveSenderLabel", () => {
  it("prefers display + identifier when both are available", () => {
    expect(
      resolveSenderLabel({
        name: " Alice ",
        e164: " +15551234567 ",
      }),
    ).toBe("Alice (+15551234567)");
  });

  it("falls back to identifier-only labels", () => {
    expect(
      resolveSenderLabel({
        id: " user-123 ",
      }),
    ).toBe("user-123");
  });

  it("returns null when all values are empty", () => {
    expect(
      resolveSenderLabel({
        name: " ",
        username: "",
        tag: "   ",
      }),
    ).toBeNull();
  });
});
