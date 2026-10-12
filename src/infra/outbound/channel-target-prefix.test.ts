// Covers provider-owned target prefixes, generic kind prefixes, topic suffixes,
// and selected-channel prefix validation.
import { describe, expect, it } from "vitest";
import { stripOutboundTargetKindPrefix, stripTargetTopicSuffix } from "./channel-target-prefix.js";

describe("stripOutboundTargetKindPrefix", () => {
  it("uses the current custom kinds on every call", () => {
    const kinds = ["room"];
    expect(stripOutboundTargetKindPrefix("room:Room-A", kinds)).toBe("Room-A");
    kinds[0] = "user";
    expect(stripOutboundTargetKindPrefix("room:Room-A", kinds)).toBe("room:Room-A");
    expect(stripOutboundTargetKindPrefix("user:User-A", kinds)).toBe("User-A");
    expect(stripOutboundTargetKindPrefix("room:Room-A")).toBe("Room-A");
  });

  it("preserves custom pattern and empty-list behavior", () => {
    expect(stripOutboundTargetKindPrefix("THREAD:Room-A", [" room|thread "])).toBe("Room-A");
    expect(stripOutboundTargetKindPrefix(" room:Room-A ", [])).toBe("room:Room-A");
    expect(() => stripOutboundTargetKindPrefix("room:Room-A", ["["])).toThrow(SyntaxError);
  });
});

describe("stripTargetTopicSuffix", () => {
  it("strips explicit topic suffixes", () => {
    expect(stripTargetTopicSuffix("room-a:topic:77")).toBe("room-a");
  });

  it("strips Telegram numeric topic shorthand only when requested", () => {
    expect(stripTargetTopicSuffix("-100200300:77", { allowNumericShorthand: true })).toBe(
      "-100200300",
    );
  });
});
