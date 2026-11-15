// Sender label tests cover display-label formatting for channel senders.
import { describe, expect, it } from "vitest";
import { resolveSenderLabel } from "./sender-label.js";

describe("resolveSenderLabel", () => {
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

describe("resolveSenderLabel opaque ids", () => {
  it("never appends an opaque profile UUID to the display label", () => {
    expect(
      resolveSenderLabel({
        name: "steipete",
        id: "c3e32452-0467-47e5-aafa-233cd5dae29f",
      }),
    ).toBe("steipete");
  });

  it("still appends a disambiguating handle", () => {
    expect(resolveSenderLabel({ name: "Peter", id: "peter@example.com" })).toBe(
      "Peter (peter@example.com)",
    );
  });
});
