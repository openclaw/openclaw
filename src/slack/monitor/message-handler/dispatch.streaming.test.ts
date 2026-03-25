import { describe, expect, it, vi } from "vitest";
import { SILENT_REPLY_TOKEN } from "../../../auto-reply/tokens.js";
import {
  applySlackFinalReplyGuardsSafely,
  didSlackDispatchDeliverAnyReply,
  formatSlackSuppressedReplyPreview,
  isSlackStreamingEnabled,
  isSlackSuppressedReplyPayload,
  requireSlackDispatchResult,
  resolveSlackReplyStreamingPolicy,
  resolveSlackStreamingThreadHint,
  settleSlackDispatchAfterRun,
  shouldApplySlackFinalReplyGuards,
  shouldSkipSlackReplyDelivery,
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

describe("slack incident-thread streaming policy", () => {
  it("disables previews, partial streams, and progress acks in incident-root-only channels", () => {
    expect(
      resolveSlackReplyStreamingPolicy({
        mode: "partial",
        nativeStreaming: true,
        incidentRootOnly: true,
      }),
    ).toEqual({
      previewStreamingEnabled: false,
      streamingEnabled: false,
      sendProgressAck: false,
      finalOnlyReplies: true,
      disableTypingTtl: true,
    });
  });

  it("keeps normal streaming behavior outside incident-root-only channels", () => {
    expect(
      resolveSlackReplyStreamingPolicy({
        mode: "progress",
        nativeStreaming: true,
        incidentRootOnly: false,
      }),
    ).toEqual({
      previewStreamingEnabled: true,
      streamingEnabled: false,
      sendProgressAck: true,
      finalOnlyReplies: false,
      disableTypingTtl: false,
    });
  });

  it("treats undefined incidentRootOnly as normal non-incident behavior", () => {
    expect(
      resolveSlackReplyStreamingPolicy({
        mode: "partial",
        nativeStreaming: true,
        incidentRootOnly: undefined,
      }),
    ).toEqual({
      previewStreamingEnabled: true,
      streamingEnabled: true,
      sendProgressAck: false,
      finalOnlyReplies: false,
      disableTypingTtl: false,
    });
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

describe("slack suppressed final delivery accounting", () => {
  it("always settles draft, typing, ack cleanup, and stream stop after dispatch", async () => {
    const draftStream = { stop: vi.fn() };
    const markDispatchIdle = vi.fn();
    const onRemoveAckReaction = vi.fn();
    const stopStream = vi.fn().mockResolvedValue(undefined);
    const streamSession = { stopped: false } as never;

    await settleSlackDispatchAfterRun({
      draftStream,
      markDispatchIdle,
      streamSession,
      stopStream,
      onRemoveAckReaction,
    });

    expect(draftStream.stop).toHaveBeenCalledOnce();
    expect(markDispatchIdle).toHaveBeenCalledOnce();
    expect(onRemoveAckReaction).toHaveBeenCalledOnce();
    expect(stopStream).toHaveBeenCalledWith({ session: streamSession });
  });

  it("still settles local cleanup when stream stop fails", async () => {
    const draftStream = { stop: vi.fn() };
    const markDispatchIdle = vi.fn();
    const onRemoveAckReaction = vi.fn();
    const onStopStreamError = vi.fn();
    const stopStream = vi.fn().mockRejectedValue(new Error("stop failed"));
    const streamSession = { stopped: false } as never;

    await settleSlackDispatchAfterRun({
      draftStream,
      markDispatchIdle,
      streamSession,
      stopStream,
      onRemoveAckReaction,
      onStopStreamError,
    });

    expect(draftStream.stop).toHaveBeenCalledOnce();
    expect(markDispatchIdle).toHaveBeenCalledOnce();
    expect(onRemoveAckReaction).toHaveBeenCalledOnce();
    expect(onStopStreamError).toHaveBeenCalledOnce();
  });

  it("applies final-reply guards only to final deliveries", () => {
    expect(shouldApplySlackFinalReplyGuards("tool")).toBe(false);
    expect(shouldApplySlackFinalReplyGuards("block")).toBe(false);
    expect(shouldApplySlackFinalReplyGuards("final")).toBe(true);
  });

  it("skips tool and block deliveries in final-only Slack threads", () => {
    expect(shouldSkipSlackReplyDelivery({ kind: "tool", finalOnlyReplies: true })).toBe(true);
    expect(shouldSkipSlackReplyDelivery({ kind: "block", finalOnlyReplies: true })).toBe(true);
    expect(shouldSkipSlackReplyDelivery({ kind: "final", finalOnlyReplies: true })).toBe(false);
    expect(shouldSkipSlackReplyDelivery({ kind: "tool", finalOnlyReplies: false })).toBe(false);
    expect(shouldSkipSlackReplyDelivery({ kind: "block", finalOnlyReplies: false })).toBe(false);
  });

  it("treats empty non-media finals as suppressed", () => {
    expect(isSlackSuppressedReplyPayload({ text: "" })).toBe(true);
    expect(isSlackSuppressedReplyPayload({ text: "   " })).toBe(true);
    expect(isSlackSuppressedReplyPayload({ text: SILENT_REPLY_TOKEN })).toBe(true);
    expect(isSlackSuppressedReplyPayload({ text: "", isError: true })).toBe(true);
    expect(isSlackSuppressedReplyPayload({ text: "", channelData: { kind: "noop" } })).toBe(true);
    expect(isSlackSuppressedReplyPayload({ text: "PR #123 is green." })).toBe(false);
    expect(isSlackSuppressedReplyPayload({ mediaUrl: "https://example.com/file.png" })).toBe(false);
  });

  it("uses actual Slack delivery instead of queued final counts", () => {
    expect(
      didSlackDispatchDeliverAnyReply({
        deliveredReplyCount: 0,
        queuedFinal: true,
        counts: { final: 1 },
      }),
    ).toBe(false);
    expect(
      didSlackDispatchDeliverAnyReply({
        deliveredReplyCount: 1,
        queuedFinal: true,
        counts: { final: 1 },
      }),
    ).toBe(true);
  });

  it("builds suppressed previews without crashing on empty text", () => {
    expect(formatSlackSuppressedReplyPreview(undefined)).toBe("");
    expect(formatSlackSuppressedReplyPreview("  hello\nthere  ")).toBe("hello there");
  });

  it("rethrows the original dispatch error after cleanup", () => {
    const err = new Error("dispatch failed");
    expect(() => requireSlackDispatchResult(undefined, err)).toThrow(err);
    expect(requireSlackDispatchResult({ queuedFinal: false }, undefined)).toEqual({
      queuedFinal: false,
    });
  });

  it("falls back to the original payload when final guard evaluation throws", () => {
    const payload = {} as { text?: string };
    Object.defineProperty(payload, "text", {
      get() {
        throw new Error("boom");
      },
    });
    const onError = vi.fn();

    expect(
      applySlackFinalReplyGuardsSafely({
        questionText: "question",
        inboundText: "question",
        incidentRootOnly: true,
        isThreadReply: true,
        payload,
        onError,
      }),
    ).toBe(payload);
    expect(onError).toHaveBeenCalledOnce();
    expect(String(onError.mock.calls[0]?.[0])).toContain("incidentRootOnly=true");
    expect(String(onError.mock.calls[0]?.[0])).toContain("textLength=0");
    expect(String(onError.mock.calls[0]?.[0])).toContain("boom");
  });
});
