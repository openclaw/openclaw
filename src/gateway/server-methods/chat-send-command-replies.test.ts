import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  getReplyPayloadMetadata,
  setReplyPayloadMetadata,
  type ReplyPayload,
} from "../../auto-reply/reply-payload.js";
import type { ReplyDispatchOperation } from "../../auto-reply/reply/reply-dispatcher.types.js";
import { createStructuredOutboundPayloadPlan } from "../../infra/outbound/payloads.js";
import { collectReplyMediaEntries } from "../../infra/outbound/reply-media-entries.js";
import {
  selectChatSendFinalReplyInputs,
  readChatSendReplyPayload,
} from "./chat-send-command-replies.js";

function selectRawReplies(params: {
  deliveredReplies: readonly { kind: "block" | "final"; payload: ReplyPayload }[];
  foldCommandBlocks: boolean;
  suppressReplies: boolean;
}) {
  return selectChatSendFinalReplyInputs({
    ...params,
    deliveredReplies: params.deliveredReplies.map(({ kind, payload }) => ({
      kind,
      input: { kind: "raw", payload },
    })),
  }).map(readChatSendReplyPayload);
}

describe("selectChatSendFinalReplyInputs", () => {
  it.each(["raw", "prepared"] as const)(
    "keeps a sensitive prepared final from exposing matching %s block media",
    (blockKind) => {
      const blockPayload = setReplyPayloadMetadata(
        { text: "preview", mediaUrl: "/tmp/paired.png" },
        { assistantMessageIndex: 1 },
      );
      const [blockPlan, finalPlan] = createStructuredOutboundPayloadPlan([
        blockPayload,
        { text: "private", mediaUrl: "/tmp/paired.png", sensitiveMedia: true },
      ]);
      if (!blockPlan || !finalPlan) {
        throw new Error("expected both media plans");
      }
      const blockInput: ReplyDispatchOperation =
        blockKind === "raw"
          ? { kind: "raw", payload: blockPayload }
          : { kind: "prepared", plan: blockPlan };
      const inputs = selectChatSendFinalReplyInputs({
        deliveredReplies: [
          { kind: "block", input: blockInput },
          { kind: "final", input: { kind: "prepared", plan: finalPlan } },
        ],
        foldCommandBlocks: true,
        suppressReplies: false,
      });

      expect(inputs).toHaveLength(2);
      expect(inputs.map((input) => readChatSendReplyPayload(input).sensitiveMedia)).toEqual([
        true,
        true,
      ]);
      if (blockKind === "prepared") {
        expect(
          getReplyPayloadMetadata(readChatSendReplyPayload(inputs[0]!))?.assistantMessageIndex,
        ).toBe(1);
      }
      expect(blockPayload).not.toHaveProperty("sensitiveMedia");
    },
  );

  it("keeps prepared replies from distinct writers separate when visible content matches", () => {
    const plans = createStructuredOutboundPayloadPlan(
      ["first-writer", "second-writer"].map((expectedWriterRunId) =>
        setReplyPayloadMetadata(
          { text: "done" },
          {
            sessionWriterDeliveryAuthority: {
              sessionKey: "agent:main:main",
              expectedSessionId: "session-1",
              expectedWriterRunId,
            },
          },
        ),
      ),
    );
    const inputs = selectChatSendFinalReplyInputs({
      deliveredReplies: plans.map((plan, index) => ({
        kind: index === 0 ? "block" : "final",
        input: { kind: "prepared", plan },
      })),
      foldCommandBlocks: true,
      suppressReplies: false,
    });

    expect(inputs).toHaveLength(2);
    expect(inputs.map((input) => input.kind === "prepared" && input.plan)).toEqual(plans);
    expect(
      plans.map(
        ({ payload }) =>
          getReplyPayloadMetadata(payload)?.sessionWriterDeliveryAuthority?.expectedWriterRunId,
      ),
    ).toEqual(["first-writer", "second-writer"]);
  });

  it("keeps final replies and suppresses already-persisted media replies", () => {
    const deliveredReplies = [
      { kind: "block" as const, payload: { text: "progress" } },
      { kind: "final" as const, payload: { text: "done" } },
    ];

    expect(
      selectRawReplies({
        deliveredReplies,
        foldCommandBlocks: false,
        suppressReplies: false,
      }),
    ).toEqual([{ text: "done" }]);
    expect(
      selectRawReplies({
        deliveredReplies,
        foldCommandBlocks: true,
        suppressReplies: true,
      }),
    ).toEqual([]);
  });

  it("folds duplicate command media and semantics into the block reply", () => {
    const deliveredReplies = [
      {
        kind: "block" as const,
        payload: {
          text: "done",
          mediaUrl: "file:///tmp/result.png",
          trustedLocalMedia: true,
        },
      },
      {
        kind: "final" as const,
        payload: {
          text: "done",
          mediaUrls: ["/tmp/result.png"],
          sensitiveMedia: true,
          replyToId: "message-1",
          attachments: [
            { path: "/tmp/result.png", name: "Result chart.png", mimeType: "image/png" },
          ],
        },
      },
    ];
    const originalReplies = structuredClone(deliveredReplies);
    const replies = selectRawReplies({
      deliveredReplies,
      foldCommandBlocks: true,
      suppressReplies: false,
    });

    expect(replies.map(({ attachments: _attachments, ...payload }) => payload)).toEqual([
      {
        text: "done",
        mediaUrl: undefined,
        mediaUrls: ["file:///tmp/result.png"],
        trustedLocalMedia: true,
        sensitiveMedia: true,
        replyToId: "message-1",
      },
    ]);
    expect(replies.flatMap((payload) => collectReplyMediaEntries(payload))).toMatchObject([
      {
        url: "file:///tmp/result.png",
        attachment: { name: "Result chart.png", mimeType: "image/png" },
      },
    ]);
    expect(deliveredReplies).toEqual(originalReplies);
  });

  it("keeps unmatched final text while deduplicating its media", () => {
    expect(
      selectRawReplies({
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

  it.each([
    { caption: "matching", blockText: "done", expectedTexts: ["done"] },
    { caption: "different", blockText: "preview", expectedTexts: ["preview", "done"] },
  ])("retains duplicate command image metadata with $caption captions", (testCase) => {
    const mediaPath = path.resolve("media", "chart-01.png");
    const mediaUrl = pathToFileURL(mediaPath).href;
    const attachment = {
      path: mediaPath,
      name: "Quarterly chart.png",
      mimeType: "image/png",
      width: 640,
    };
    const deliveredReplies = [
      {
        kind: "block" as const,
        payload: {
          text: testCase.blockText,
          mediaUrl,
          attachments: [{ path: mediaPath, height: 480 }],
        },
      },
      {
        kind: "final" as const,
        payload: { text: "done", mediaUrls: [mediaPath], attachments: [attachment] },
      },
    ];
    const originalReplies = structuredClone(deliveredReplies);

    const replies = selectRawReplies({
      deliveredReplies,
      foldCommandBlocks: true,
      suppressReplies: false,
    });

    expect(replies.map((payload) => payload.text)).toEqual(testCase.expectedTexts);
    expect(replies.flatMap((payload) => payload.mediaUrls ?? [])).toEqual([mediaUrl]);
    expect(replies[0]).toMatchObject({
      mediaUrls: [mediaUrl],
      attachments: [{ ...attachment, path: mediaUrl, height: 480 }],
    });
    expect(deliveredReplies).toEqual(originalReplies);
  });
});
