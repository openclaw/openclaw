import path from "node:path";
import { pathToFileURL } from "node:url";
import { assert, expect, it } from "vitest";
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
import { buildAssistantReplyContent } from "./chat-assistant-content.js";
import {
  buildTranscriptReplyTextFromInputs,
  selectChatSendFinalReplyInputs,
  readChatSendReplyPayload as readPayload,
} from "./chat-send-command-replies.js";

const raw = (payload: ReplyPayload): ReplyDispatchOperation => ({ kind: "raw", payload });

function selectReplies(
  block: ReplyDispatchOperation,
  final: ReplyDispatchOperation,
  options: { foldCommandBlocks?: boolean; suppressReplies?: boolean } = {},
) {
  return selectChatSendFinalReplyInputs({
    foldCommandBlocks: true,
    suppressReplies: false,
    ...options,
    deliveredReplies: [
      { kind: "block", input: block },
      { kind: "final", input: final },
    ],
  });
}

it("keeps consumed reply policy when raw duplicate replies are folded", () => {
  const filter = createReplyToModeFilterForChannel("first", "telegram");
  filter({ text: "First", replyToId: "source" });
  const later = filter({ text: "Later", replyToId: "source", replyToCurrent: true });
  const modified = copyReplyPayloadMetadata(later, {
    ...later,
    replyToId: "later-target",
    mediaUrl: "https://example.invalid/document.txt",
  });
  const selected = selectReplies(raw(modified), raw(modified)).map(readPayload);
  const plans = createOutboundPayloadPlan(selected);
  expect(plans.map(({ payload: p }) => [p.replyToId, p.replyToCurrent])).toEqual([
    [undefined, false],
  ]);
});
it.each(["raw", "prepared"] as const)(
  "keeps distinct writers and sensitive media when a prepared final matches a %s block",
  (blockKind) => {
    const writerPayload = (expectedWriterRunId: string, sensitiveMedia?: true) =>
      setReplyPayloadMetadata(
        {
          text: "done",
          mediaUrl: "/tmp/paired.png",
          ...(sensitiveMedia ? { sensitiveMedia } : {}),
        },
        {
          assistantMessageIndex: 1,
          sessionWriterDeliveryAuthority: {
            sessionKey: "agent:main:main",
            expectedSessionId: "session-1",
            expectedWriterRunId,
          },
        },
      );
    const blockPayload = writerPayload("first-writer");
    const [blockPlan, finalPlan] = createStructuredOutboundPayloadPlan([
      blockPayload,
      writerPayload("second-writer", true),
    ]);
    assert(blockPlan && finalPlan, "expected both media plans");
    const blockInput: ReplyDispatchOperation =
      blockKind === "raw" ? raw(blockPayload) : { kind: "prepared", plan: blockPlan };
    const inputs = selectReplies(blockInput, { kind: "prepared", plan: finalPlan });

    expect(inputs.map((input) => readPayload(input).sensitiveMedia)).toEqual([true, true]);
    expect(inputs.map((input) => input.kind)).toEqual([blockKind, "prepared"]);
    expect(
      inputs.map(
        (input) =>
          getReplyPayloadMetadata(readPayload(input))?.sessionWriterDeliveryAuthority
            ?.expectedWriterRunId,
      ),
    ).toEqual(["first-writer", "second-writer"]);
    expect(getReplyPayloadMetadata(readPayload(inputs[0]!))?.assistantMessageIndex).toBe(1);
    expect(blockPayload).not.toHaveProperty("sensitiveMedia");
  },
);

it("keeps final replies and suppresses already-persisted media replies", () => {
  const block = raw({ text: "progress" });
  const final = raw({ text: "done" });
  expect(selectReplies(block, final, { foldCommandBlocks: false }).map(readPayload)).toEqual([
    { text: "done" },
  ]);
  expect(selectReplies(block, final, { suppressReplies: true })).toEqual([]);
});

it.each([true, false])("merges attachment metadata (matching captions: %s)", (matching) => {
  const blockText = matching ? "done" : "preview";
  const mediaPath = path.resolve("media", "chart-01.png");
  const mediaUrl = pathToFileURL(mediaPath).href;
  const attachment = {
    path: mediaPath,
    name: "Quarterly chart.png",
    mimeType: "image/png",
    width: 640,
  };
  const trust = matching ? { trustedLocalMedia: true } : {};
  const semantics = matching
    ? { sensitiveMedia: true, replyToId: "message-1" }
    : { audioAsVoice: true };
  const block = raw({
    text: blockText,
    mediaUrl,
    ...trust,
    attachments: [{ path: mediaPath, height: 480 }],
  });
  const final = raw({
    text: "done",
    mediaUrls: [mediaPath],
    attachments: [attachment],
    ...semantics,
  });
  const originalReplies = structuredClone([block, final]);
  const replies = selectReplies(block, final).map(readPayload);
  const merged = {
    text: blockText,
    mediaUrl: undefined,
    mediaUrls: [mediaUrl],
    attachments: [{ ...attachment, path: mediaUrl, height: 480 }],
    ...trust,
    ...semantics,
  };
  const remainingFinal = { ...readPayload(final), mediaUrl: undefined, mediaUrls: undefined };
  expect(replies).toEqual(matching ? [merged] : [merged, remainingFinal]);
  expect([block, final]).toEqual(originalReplies);
});
type TranscriptCase = [name: string, payloads: ReplyPayload[], expected: string, project?: boolean];
it.each<TranscriptCase>([
  [
    "literal control words",
    ["First instruction", "NO_REPLY", "ANNOUNCE_SKIP", "REPLY_SKIP", "Done"].map((text) => ({
      text,
    })),
    "First instruction\n\nNO_REPLY\n\nANNOUNCE_SKIP\n\nREPLY_SKIP\n\nDone",
    true,
  ],
  [
    "CRLF boundaries and whitespace-only chunks",
    [{ text: "```yaml\r\nroot:\r\n" }, { text: "  \t\n" }, { text: "  nested: true\r\n```" }],
    "```yaml\r\nroot:\r\n  nested: true\r\n```",
  ],
  [
    "reply directives and safe media without reasoning",
    [
      { text: "hidden", isReasoning: true },
      { text: "Hello", replyToId: "message-1", mediaUrls: ["https://example.test/photo.png"] },
      { text: "Listen", audioAsVoice: true, mediaUrl: "https://example.test/clip.mp3" },
      { text: "private", sensitiveMedia: true, mediaUrl: "https://example.test/private.png" },
    ],
    [
      "[[reply_to:message-1]]\nHello\nAttachment: https://example.test/photo.png",
      "Listen\nAttachment: https://example.test/clip.mp3\n[[audio_as_voice]]",
      "private",
    ].join("\n\n"),
  ],
])("preserves %s in transcript reply text", async (_name, payloads, expected, project) => {
  expect(buildTranscriptReplyTextFromInputs(payloads.map(raw))).toBe(expected);
  if (project) {
    const { assistantContent } = await buildAssistantReplyContent({
      sessionKey: "agent:main:main",
      agentId: "main",
      payloads,
    });
    expect(assistantContent).toEqual([{ type: "text", text: expected }]);
  }
});
