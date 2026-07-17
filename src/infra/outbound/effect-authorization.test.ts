import { describe, expect, it } from "vitest";
import { digestOutboundEffectPayload } from "./effect-authorization.js";

describe("outbound effect authorization digest", () => {
  it("keeps tri-state and arbitrary false fields distinct from absence", () => {
    expect(digestOutboundEffectPayload({ text: "hello", replyToCurrent: false })).not.toBe(
      digestOutboundEffectPayload({ text: "hello" }),
    );
    expect(digestOutboundEffectPayload({ text: "hello", isError: false })).not.toBe(
      digestOutboundEffectPayload({ text: "hello" }),
    );
  });

  it("normalizes only proven false defaults", () => {
    const absent = digestOutboundEffectPayload({ text: "hello" });
    expect(digestOutboundEffectPayload({ text: "hello", replyToTag: false })).toBe(absent);
    expect(digestOutboundEffectPayload({ text: "hello", audioAsVoice: false })).toBe(absent);
  });
});
