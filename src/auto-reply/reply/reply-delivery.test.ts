import { describe, expect, it, vi } from "vitest";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
import { deliverNormalizedReplyPayload } from "./reply-delivery.js";

describe("deliverNormalizedReplyPayload", () => {
  it("normalizes directives before delivery and runs commentary bookkeeping hooks", async () => {
    const deliver = vi.fn();
    const rememberSentText = vi.fn();
    const logDelivery = vi.fn();

    const result = await deliverNormalizedReplyPayload({
      payload: {
        text: "  [[reply_to_current]] Step 2/3: running lint.",
      },
      kind: "commentary",
      trimLeadingWhitespace: true,
      parseMode: "auto",
      deliver,
      rememberSentText,
      logDelivery,
    });

    expect(deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Step 2/3: running lint.",
        replyToCurrent: true,
      }),
      expect.objectContaining({
        kind: "commentary",
        hasMedia: false,
        delivered: true,
        shouldLog: true,
      }),
    );
    expect(rememberSentText).toHaveBeenCalledWith(
      "Step 2/3: running lint.",
      expect.objectContaining({
        kind: "commentary",
        shouldLog: true,
      }),
    );
    expect(logDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "commentary",
        delivered: true,
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        kind: "commentary",
        delivered: true,
        shouldLog: true,
      }),
    );
  });

  it("skips silent commentary payloads after normalization", async () => {
    const deliver = vi.fn();
    const rememberSentText = vi.fn();
    const logDelivery = vi.fn();

    const result = await deliverNormalizedReplyPayload({
      payload: { text: SILENT_REPLY_TOKEN },
      kind: "commentary",
      trimLeadingWhitespace: true,
      parseMode: "auto",
      deliver,
      rememberSentText,
      logDelivery,
    });

    expect(result.delivered).toBe(false);
    expect(result.isSilent).toBe(true);
    expect(deliver).not.toHaveBeenCalled();
    expect(rememberSentText).not.toHaveBeenCalled();
    expect(logDelivery).not.toHaveBeenCalled();
  });

  it("delivers media-only commentary payloads", async () => {
    const deliver = vi.fn();
    const rememberSentText = vi.fn();
    const logDelivery = vi.fn();

    const result = await deliverNormalizedReplyPayload({
      payload: {
        mediaUrl: "https://example.com/screenshot.png",
      },
      kind: "commentary",
      trimLeadingWhitespace: true,
      parseMode: "auto",
      deliver,
      rememberSentText,
      logDelivery,
    });

    expect(result).toEqual(
      expect.objectContaining({
        kind: "commentary",
        hasMedia: true,
        delivered: true,
        shouldLog: undefined,
      }),
    );
    expect(deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaUrl: "https://example.com/screenshot.png",
      }),
      expect.objectContaining({
        kind: "commentary",
        hasMedia: true,
        shouldLog: undefined,
      }),
    );
    expect(rememberSentText).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({
        kind: "commentary",
        hasMedia: true,
      }),
    );
    expect(logDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "commentary",
        hasMedia: true,
      }),
    );
  });

  it("passes final delivery kind into bookkeeping hooks", async () => {
    const deliver = vi.fn();
    const rememberSentText = vi.fn();
    const logDelivery = vi.fn();

    await deliverNormalizedReplyPayload({
      payload: { text: "Final summary." },
      kind: "final",
      trimLeadingWhitespace: true,
      parseMode: "auto",
      deliver,
      rememberSentText,
      logDelivery,
    });

    expect(rememberSentText).toHaveBeenCalledWith(
      "Final summary.",
      expect.objectContaining({
        kind: "final",
        shouldLog: true,
      }),
    );
    expect(logDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "final",
        delivered: true,
      }),
    );
  });
});
