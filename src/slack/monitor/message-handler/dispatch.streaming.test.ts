import { describe, expect, it } from "vitest";
import {
  isSlackStreamingEnabled,
  resolveSlackStreamingThreadHint,
  shouldForceSlackDraftBoundary,
} from "./dispatch.js";

describe("slack native streaming defaults", () => {
  it("is enabled for partial mode when native streaming is on", () => {
    expect(isSlackStreamingEnabled({ mode: "partial", nativeStreaming: true })).toBe(true);
  });

  it("is disabled outside partial mode or when native streaming is off", () => {
    expect(isSlackStreamingEnabled({ mode: "partial", nativeStreaming: false })).toBe(false);
    expect(isSlackStreamingEnabled({ mode: "block", nativeStreaming: true })).toBe(false);
    expect(isSlackStreamingEnabled({ mode: "progress", nativeStreaming: true })).toBe(false);
    expect(isSlackStreamingEnabled({ mode: "off", nativeStreaming: true })).toBe(false);
  });
});

describe("slack native streaming thread hint", () => {
  it("stays off-thread when replyToMode=off and message is not in a thread", () => {
    expect(
      resolveSlackStreamingThreadHint({
        replyToMode: "off",
        incomingThreadTs: undefined,
        messageTs: "1000.1",
      }),
    ).toBeUndefined();
  });

  it("uses first-reply thread when replyToMode=first", () => {
    expect(
      resolveSlackStreamingThreadHint({
        replyToMode: "first",
        incomingThreadTs: undefined,
        messageTs: "1000.2",
      }),
    ).toBe("1000.2");
  });

  it("uses the existing incoming thread regardless of replyToMode", () => {
    expect(
      resolveSlackStreamingThreadHint({
        replyToMode: "off",
        incomingThreadTs: "2000.1",
        messageTs: "1000.3",
      }),
    ).toBe("2000.1");
  });
});

describe("slack draft boundary rotation", () => {
  it("does not rotate status_final previews into new draft messages", () => {
    expect(
      shouldForceSlackDraftBoundary({
        hasStreamedMessage: true,
        draftMode: "status_final",
      }),
    ).toBe(false);
  });

  it("rotates replace and append previews when a streamed message exists", () => {
    expect(
      shouldForceSlackDraftBoundary({
        hasStreamedMessage: true,
        draftMode: "replace",
      }),
    ).toBe(true);
    expect(
      shouldForceSlackDraftBoundary({
        hasStreamedMessage: true,
        draftMode: "append",
      }),
    ).toBe(true);
  });
});
