import { describe, expect, it } from "vitest";
import { renderSignalMentions, renderSignalMentionsWithShifts } from "./mentions.js";

const PLACEHOLDER = "\uFFFC";

describe("renderSignalMentions", () => {
  it("returns the original message when no mentions are provided", () => {
    const message = `${PLACEHOLDER} ping`;
    expect(renderSignalMentions(message, null)).toBe(message);
    expect(renderSignalMentions(message, [])).toBe(message);
  });

  it("replaces placeholder code points using mention metadata", () => {
    const message = `${PLACEHOLDER} hi ${PLACEHOLDER}!`;
    const result = renderSignalMentions(message, [
      { uuid: "abc-123", start: 0, length: 1 },
      { number: "+15550005555", start: message.lastIndexOf(PLACEHOLDER), length: 1 },
    ]);

    expect(result).toBe("@abc-123 hi @+15550005555!");
  });

  it("skips mentions that lack identifiers or out-of-bounds spans", () => {
    const message = `${PLACEHOLDER} hi`;
    const result = renderSignalMentions(message, [
      { name: "ignored" },
      { uuid: "valid", start: 0, length: 1 },
      { number: "+1555", start: 999, length: 1 },
    ]);

    expect(result).toBe("@valid hi");
  });
});

describe("renderSignalMentionsWithShifts", () => {
  it("returns shift metadata for downstream style-offset adjustment", () => {
    const message = `${PLACEHOLDER} ping`;
    const result = renderSignalMentionsWithShifts(message, [
      { uuid: "abc-123", start: 0, length: 1 },
    ]);

    expect(result.text).toBe("@abc-123 ping");
    expect(result.offsetShifts.size).toBe(1);
  });
});
