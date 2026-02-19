import { describe, expect, it } from "vitest";
import { isSlackStreamingEnabled, resolveSlackStreamingThreadHint } from "./dispatch.js";

describe("slack native streaming defaults", () => {
  it("defaults to enabled when undefined", () => {
    expect(isSlackStreamingEnabled(undefined)).toBe(true);
  });

  it("returns true when explicitly enabled", () => {
    expect(isSlackStreamingEnabled(true)).toBe(true);
  });

  it("returns false when explicitly disabled", () => {
    expect(isSlackStreamingEnabled(false)).toBe(false);
  });
});

describe("slack native streaming thread hint", () => {
  it("returns incomingThreadTs for reply-to-all in thread", () => {
    expect(
      resolveSlackStreamingThreadHint({
        replyToMode: "all",
        incomingThreadTs: "111.222",
        messageTs: "333.444",
      }),
    ).toBe("111.222");
  });

  it("returns messageTs for reply-to-first top-level", () => {
    expect(
      resolveSlackStreamingThreadHint({
        replyToMode: "first",
        incomingThreadTs: undefined,
        messageTs: "555.666",
      }),
    ).toBe("555.666");
  });

  it("returns undefined when reply-to is off", () => {
    expect(
      resolveSlackStreamingThreadHint({
        replyToMode: "off",
        incomingThreadTs: undefined,
        messageTs: "777.888",
      }),
    ).toBeUndefined();
  });
});
