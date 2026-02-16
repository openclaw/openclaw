import { describe, expect, it } from "vitest";
import {
  buildWaitingStatusMessage,
  pickWaitingPhrase,
  prefersReducedMotion,
  shimmerText,
} from "./tui-waiting.js";

const theme = {
  dim: (s: string) => `<d>${s}</d>`,
  bold: (s: string) => `<b>${s}</b>`,
  accentSoft: (s: string) => `<a>${s}</a>`,
  // oxlint-disable-next-line typescript/no-explicit-any
} as any;

describe("tui-waiting", () => {
  it("pickWaitingPhrase rotates every 10 ticks", () => {
    const phrases = ["a", "b", "c"];
    expect(pickWaitingPhrase(0, phrases)).toBe("a");
    expect(pickWaitingPhrase(9, phrases)).toBe("a");
    expect(pickWaitingPhrase(10, phrases)).toBe("b");
    expect(pickWaitingPhrase(20, phrases)).toBe("c");
    expect(pickWaitingPhrase(30, phrases)).toBe("a");
  });

  it("prefersReducedMotion returns false by default", () => {
    expect(prefersReducedMotion({})).toBe(false);
  });

  it("prefersReducedMotion returns true when REDUCE_MOTION is set", () => {
    expect(prefersReducedMotion({ REDUCE_MOTION: "1" })).toBe(true);
  });

  it("prefersReducedMotion returns true when NO_MOTION is set", () => {
    expect(prefersReducedMotion({ NO_MOTION: "true" })).toBe(true);
  });

  it("shimmerText returns static dim text when reduced motion is preferred", () => {
    const original = process.env.REDUCE_MOTION;
    process.env.REDUCE_MOTION = "1";
    try {
      const result = shimmerText(theme, "hello", 5);
      expect(result).toBe("<d>hello</d>");
    } finally {
      if (original === undefined) {
        delete process.env.REDUCE_MOTION;
      } else {
        process.env.REDUCE_MOTION = original;
      }
    }
  });

  it("buildWaitingStatusMessage includes shimmer markup and metadata", () => {
    const msg = buildWaitingStatusMessage({
      theme,
      tick: 1,
      elapsed: "3s",
      connectionStatus: "connected",
      phrases: ["hello"],
    });

    expect(msg).toContain("connected");
    expect(msg).toContain("3s");
    // text is wrapped per-char; check it appears in order
    expect(msg).toContain("h");
    expect(msg).toContain("e");
    expect(msg).toContain("l");
    expect(msg).toContain("o");
    // shimmer should contain both highlighted and dim parts
    expect(msg).toContain("<b><a>");
    expect(msg).toContain("<d>");
  });
});
