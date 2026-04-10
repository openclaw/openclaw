import { describe, expect, it } from "vitest";
import { resolveMergedAssistantText } from "./server-chat.js";

describe("resolveMergedAssistantText", () => {
  it("appends deltas without overlap-stripping (preserves repeated digits / UUID segments)", () => {
    expect(
      resolveMergedAssistantText({
        previousText: "…c7bc32",
        nextText: "",
        nextDelta: "2c-17ad",
      }),
    ).toBe("…c7bc322c-17ad");
  });

  it("appends k1 + 119 without collapsing repeated 1s", () => {
    expect(
      resolveMergedAssistantText({
        previousText: "（k1",
        nextText: "",
        nextDelta: "119",
      }),
    ).toBe("（k1119");
  });

  it("uses full nextText when it extends the buffer (normal streaming)", () => {
    expect(
      resolveMergedAssistantText({
        previousText: "（k1",
        nextText: "（k1119",
        nextDelta: "119",
      }),
    ).toBe("（k1119");
  });

  it("concatenates tool-style disjoint segments via delta", () => {
    expect(
      resolveMergedAssistantText({
        previousText: "Before tool call",
        nextText: "After tool call",
        nextDelta: "\nAfter tool call",
      }),
    ).toBe("Before tool call\nAfter tool call");
  });
});
