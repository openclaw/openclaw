import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import {
  getReplyPayloadMetadata,
  isReplyPayloadSessionWriterDeliveryAuthorized,
  setReplyPayloadMetadata,
  type ReplyPayload,
} from "../../auto-reply/reply-payload.js";
import { selectChatSendFinalReplyPayloads } from "./chat-send-command-replies.js";

describe("selectChatSendFinalReplyPayloads", () => {
  it.each(["final", "block", "duplicate-text", "duplicate-media", "shared-media"] as const)(
    "keeps final delivery receipts and transcript authority through %s folding",
    async (shape) => {
      const delivered = vi.fn();
      const media = shape === "duplicate-media" || shape === "shared-media";
      const final = setReplyPayloadMetadata<ReplyPayload>(
        {
          text: "Answer with policy notice",
          ...(media ? { mediaUrls: ["/tmp/result.png"], sensitiveMedia: true } : {}),
        },
        {
          onFinalDeliverySuccess: delivered,
          assistantTranscriptOwned: true,
          assistantTranscriptIdempotencyKey: "final-row",
          sessionWriterDeliveryAuthority: { sessionKey: "main", expectedSessionId: "current" },
        },
      );
      const block = setReplyPayloadMetadata<ReplyPayload>(
        {
          text: shape === "shared-media" ? "Progress" : final.text,
          ...(media ? { mediaUrl: "/tmp/result.png" } : {}),
        },
        { blockSourceText: "original block" },
      );
      const deliveredReplies =
        shape === "block"
          ? [{ kind: "block" as const, payload: final }]
          : shape === "final"
            ? [{ kind: "final" as const, payload: final }]
            : [
                { kind: "block" as const, payload: block },
                { kind: "final" as const, payload: final },
              ];
      const result = selectChatSendFinalReplyPayloads({
        deliveredReplies,
        foldCommandBlocks: true,
        suppressReplies: false,
      });
      const reply = expectDefined(
        result.find((payload) => payload.text === final.text),
        "final policy reply",
      );
      expect(result).toHaveLength(shape === "shared-media" ? 2 : 1);
      expect(getReplyPayloadMetadata(reply)).toMatchObject({
        assistantTranscriptOwned: true,
        assistantTranscriptIdempotencyKey: "final-row",
        onFinalDeliverySuccess: delivered,
      });
      expect(isReplyPayloadSessionWriterDeliveryAuthorized(reply, { sessionId: "replaced" })).toBe(
        false,
      );
      expect(isReplyPayloadSessionWriterDeliveryAuthorized(reply, { sessionId: "current" })).toBe(
        true,
      );
      if (shape === "duplicate-text" || shape === "duplicate-media") {
        expect(getReplyPayloadMetadata(reply)?.blockSourceText).toBe("original block");
      }
      if (shape === "shared-media") {
        const blockReply = expectDefined(result[0], "shared-media block");
        expect(getReplyPayloadMetadata(blockReply)?.blockSourceText).toBe("original block");
        expect(getReplyPayloadMetadata(blockReply)?.onFinalDeliverySuccess).toBeUndefined();
      }
      expect(delivered).not.toHaveBeenCalled();
      await getReplyPayloadMetadata(reply)?.onFinalDeliverySuccess?.();
      expect(delivered).toHaveBeenCalledOnce();
    },
  );

  it("keeps final replies and suppresses already-persisted media replies", () => {
    const deliveredReplies = [
      { kind: "block" as const, payload: { text: "progress" } },
      { kind: "final" as const, payload: { text: "done" } },
    ];

    expect(
      selectChatSendFinalReplyPayloads({
        deliveredReplies,
        foldCommandBlocks: false,
        suppressReplies: false,
      }),
    ).toEqual([{ text: "done" }]);
    expect(
      selectChatSendFinalReplyPayloads({
        deliveredReplies,
        foldCommandBlocks: true,
        suppressReplies: true,
      }),
    ).toEqual([]);
  });

  it("folds duplicate command media and semantics into the block reply", () => {
    expect(
      selectChatSendFinalReplyPayloads({
        deliveredReplies: [
          {
            kind: "block",
            payload: {
              text: "done",
              mediaUrl: "file:///tmp/result.png",
              trustedLocalMedia: true,
            },
          },
          {
            kind: "final",
            payload: {
              text: "done",
              mediaUrls: ["/tmp/result.png"],
              sensitiveMedia: true,
              replyToId: "message-1",
            },
          },
        ],
        foldCommandBlocks: true,
        suppressReplies: false,
      }),
    ).toEqual([
      {
        text: "done",
        mediaUrl: undefined,
        mediaUrls: ["file:///tmp/result.png"],
        trustedLocalMedia: true,
        sensitiveMedia: true,
        replyToId: "message-1",
      },
    ]);
  });

  it("keeps unmatched final text while deduplicating its media", () => {
    expect(
      selectChatSendFinalReplyPayloads({
        deliveredReplies: [
          {
            kind: "block",
            payload: { text: "progress", mediaUrl: "/tmp/result.png" },
          },
          {
            kind: "final",
            payload: {
              text: "done",
              mediaUrl: "file:///tmp/result.png",
              audioAsVoice: true,
            },
          },
        ],
        foldCommandBlocks: true,
        suppressReplies: false,
      }),
    ).toEqual([
      {
        text: "progress",
        mediaUrl: undefined,
        mediaUrls: ["/tmp/result.png"],
        audioAsVoice: true,
      },
      {
        text: "done",
        mediaUrl: undefined,
        mediaUrls: undefined,
        audioAsVoice: true,
      },
    ]);
  });
});
