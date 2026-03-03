import { describe, expect, it } from "vitest";
import { matchesMentionWithExplicit, stripStructuralPrefixes } from "./mentions.js";

describe("stripStructuralPrefixes", () => {
  it("returns empty string for undefined input at runtime", () => {
    expect(stripStructuralPrefixes(undefined as unknown as string)).toBe("");
  });

  it("returns empty string for empty input", () => {
    expect(stripStructuralPrefixes("")).toBe("");
  });

  it("strips sender prefix labels", () => {
    expect(stripStructuralPrefixes("John: hello")).toBe("hello");
  });

  it("passes through plain text", () => {
    expect(stripStructuralPrefixes("just a message")).toBe("just a message");
  });
});

describe("matchesMentionWithExplicit", () => {
  it("treats explicit mentions as mentioned when explicit identity cannot be resolved", () => {
    const wasMentioned = matchesMentionWithExplicit({
      text: "@J_A_R_V_1_S_bot hola",
      mentionRegexes: [],
      explicit: {
        hasAnyMention: true,
        isExplicitlyMentioned: false,
        canResolveExplicit: false,
      },
    });

    expect(wasMentioned).toBe(true);
  });
});
