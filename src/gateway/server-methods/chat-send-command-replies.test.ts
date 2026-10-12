import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  copyReplyPayloadMetadata,
  getReplyPayloadMetadata,
  setReplyPayloadMetadata,
  type ReplyPayload,
} from "../../auto-reply/reply-payload.js";
import type { ReplyDispatchOperation } from "../../auto-reply/reply/reply-dispatcher.types.js";
import { createReplyToModeFilterForChannel } from "../../auto-reply/reply/reply-threading.js";
import {
  createOutboundPayloadPlan,
  createStructuredOutboundPayloadPlan,
} from "../../infra/outbound/payloads.js";
import { collectReplyMediaEntries } from "../../infra/outbound/reply-media-entries.js";
import { buildAssistantReplyContent } from "./chat-assistant-content.js";
import {
  buildTranscriptReplyTextFromInputs,
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
  it("keeps consumed reply policy when raw duplicate replies are folded", () => {
    const filter = createReplyToModeFilterForChannel("first", "telegram");
    filter({ text: "First", replyToId: "source" });
    const later = filter({ text: "Later", replyToId: "source", replyToCurrent: true });
    const modified = copyReplyPayloadMetadata(later, {
      ...later,
      replyToId: "later-target",
      mediaUrl: "https://example.invalid/document.txt",
    });
    const selected = selectRawReplies({
      deliveredReplies: [
        { kind: "block", payload: modified },
        { kind: "final", payload: modified },
      ],
      foldCommandBlocks: true,
      suppressReplies: false,
    });
    const plans = createOutboundPayloadPlan(selected);
    expect(plans).toHaveLength(1);
    expect(plans[0]?.payload.replyToId).toBeUndefined();
    expect(plans[0]?.payload.replyToCurrent).toBe(false);
  });
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

      expect(inputs.map((input) => readChatSendReplyPayload(input).sensitiveMedia)).toEqual([
        true,
        true,
      ]);
      expect(
        getReplyPayloadMetadata(readChatSendReplyPayload(inputs[0]!))?.assistantMessageIndex,
      ).toBe(1);
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

    expect(inputs.map((input) => input.kind === "prepared" && input.plan)).toEqual(plans);
    expect(
      inputs.map(
        (input) =>
          getReplyPayloadMetadata(readChatSendReplyPayload(input))?.sessionWriterDeliveryAuthority
            ?.expectedWriterRunId,
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
          ...(testCase.caption === "matching" ? { trustedLocalMedia: true } : {}),
          attachments: [{ path: mediaPath, height: 480 }],
        },
      },
      {
        kind: "final" as const,
        payload: {
          text: "done",
          mediaUrls: [mediaPath],
          attachments: [attachment],
          ...(testCase.caption === "matching"
            ? { sensitiveMedia: true, replyToId: "message-1" }
            : { audioAsVoice: true }),
        },
      },
    ];
    const originalReplies = structuredClone(deliveredReplies);

    const replies = selectRawReplies({
      deliveredReplies,
      foldCommandBlocks: true,
      suppressReplies: false,
    });

    expect(replies.map(({ attachments: _attachments, ...payload }) => payload)).toEqual(
      testCase.caption === "matching"
        ? [
            {
              text: "done",
              mediaUrl: undefined,
              mediaUrls: [mediaUrl],
              trustedLocalMedia: true,
              sensitiveMedia: true,
              replyToId: "message-1",
            },
          ]
        : [
            { text: "preview", mediaUrl: undefined, mediaUrls: [mediaUrl], audioAsVoice: true },
            { text: "done", mediaUrl: undefined, mediaUrls: undefined, audioAsVoice: true },
          ],
    );
    if (testCase.caption === "matching") {
      expect(replies.flatMap((payload) => collectReplyMediaEntries(payload))).toMatchObject([
        { url: mediaUrl, attachment: { name: "Quarterly chart.png", mimeType: "image/png" } },
      ]);
    }
    expect(replies.map((payload) => payload.text)).toEqual(testCase.expectedTexts);
    expect(replies.flatMap((payload) => payload.mediaUrls ?? [])).toEqual([mediaUrl]);
    expect(replies[0]).toMatchObject({
      mediaUrls: [mediaUrl],
      attachments: [{ ...attachment, path: mediaUrl, height: 480 }],
    });
    expect(deliveredReplies).toEqual(originalReplies);
  });
});

function buildRawTranscriptReplyText(payloads: ReplyPayload[]): string {
  return buildTranscriptReplyTextFromInputs(payloads.map((payload) => ({ kind: "raw", payload })));
}

describe("buildTranscriptReplyTextFromInputs", () => {
  it.each([
    ...["NO_REPLY", "ANNOUNCE_SKIP", "REPLY_SKIP"].map((controlText) => ({
      name: `suppressed ${controlText}`,
      payloads: [{ text: "First instruction" }, { text: controlText }, { text: "Done" }],
      expected: "First instruction\n\nDone",
      project: true,
    })),
    {
      name: "split fenced-code indentation",
      payloads: [
        { text: "Here is the YAML:\n\n```yaml\nroot:\n" },
        { text: "  nested:\n    value: true\n```" },
      ],
      expected: "Here is the YAML:\n\n```yaml\nroot:\n  nested:\n    value: true\n```",
      project: false,
    },
    {
      name: "CRLF boundaries and whitespace-only chunks",
      payloads: [
        { text: "```yaml\r\nroot:\r\n" },
        { text: "  \t\n" },
        { text: "  nested: true\r\n```" },
      ],
      expected: "```yaml\r\nroot:\r\n  nested: true\r\n```",
      project: false,
    },
    {
      name: "reply directives and safe media without reasoning",
      payloads: [
        { text: "hidden", isReasoning: true },
        { text: "Hello", replyToId: "message-1", mediaUrls: ["https://example.test/photo.png"] },
        { text: "Listen", audioAsVoice: true, mediaUrl: "https://example.test/clip.mp3" },
        { text: "private", sensitiveMedia: true, mediaUrl: "https://example.test/private.png" },
      ],
      expected: [
        "[[reply_to:message-1]]\nHello\nAttachment: https://example.test/photo.png",
        "Listen\nAttachment: https://example.test/clip.mp3\n[[audio_as_voice]]",
        "private",
      ].join("\n\n"),
      project: false,
    },
  ])("preserves $name in transcript reply text", async ({ payloads, expected, project }) => {
    expect(buildRawTranscriptReplyText(payloads)).toBe(expected);
    if (project) {
      const { assistantContent } = await buildAssistantReplyContent({
        sessionKey: "agent:main:main",
        agentId: "main",
        payloads,
      });
      expect(assistantContent).toEqual([{ type: "text", text: expected }]);
    }
  });
});
