import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  getReplyPayloadMetadata,
  setReplyPayloadMetadata,
  type ReplyPayload,
} from "../../auto-reply/reply-payload.js";
import {
  createStructuredOutboundPayloadPlan,
  projectOutboundPayloadPlanForDelivery,
  projectOutboundPayloadPlanForMirror,
} from "./payloads.js";

describe("createStructuredOutboundPayloadPlan", () => {
  it.each([
    "[[reply_to:example-id]]` literally.",
    "[[audio_as_voice]]` literally.",
    "MEDIA:https://example.com/literal.png",
    "NO_REPLY",
    "Replied in-thread.",
    "  Preserve this indentation.  \r\n",
  ])("keeps prepared text literal: %j", (text) => {
    const plan = createStructuredOutboundPayloadPlan([{ text }]);

    expect(projectOutboundPayloadPlanForDelivery(plan)).toEqual([
      { text, mediaUrl: undefined, mediaUrls: undefined },
    ]);
  });

  it("preserves structured fields, metadata, attachment order, and source indexes", () => {
    const primaryPath = path.resolve("media", "primary.png");
    const secondaryPath = path.resolve("media", "secondary.png");
    const payload: ReplyPayload = setReplyPayloadMetadata(
      {
        text: "[[reply_to:literal]] [[audio_as_voice]]\nMEDIA:https://example.com/literal.png",
        replyToId: "prepared-target",
        replyToTag: false,
        replyToCurrent: false,
        audioAsVoice: false,
        mediaUrl: ` ${primaryPath} `,
        mediaUrls: [` ${secondaryPath} `, primaryPath],
        attachments: [
          { url: pathToFileURL(secondaryPath).href, name: "Second chart.png", width: 640 },
          { path: pathToFileURL(primaryPath).href, name: "Primary chart.png", height: 480 },
        ],
        presentation: { blocks: [{ type: "text", text: "Prepared card" }] },
      },
      { nonTerminalToolErrorWarning: true },
    );
    const before = structuredClone(payload);
    const reasoning: ReplyPayload = { text: "Reasoning", isReasoning: true };
    const plan = createStructuredOutboundPayloadPlan([reasoning, {}, payload]);
    const [deliveredReasoning, delivered] = projectOutboundPayloadPlanForDelivery(plan);

    expect(plan.map((entry) => entry.sourceIndex)).toEqual([0, 2]);
    expect(deliveredReasoning).toEqual({ ...reasoning, mediaUrl: undefined, mediaUrls: undefined });
    expect(delivered).toEqual({
      ...before,
      mediaUrl: undefined,
      mediaUrls: [secondaryPath, primaryPath],
    });
    expect(delivered && getReplyPayloadMetadata(delivered)).toEqual({
      nonTerminalToolErrorWarning: true,
    });
    expect(payload).toEqual(before);
    expect(projectOutboundPayloadPlanForMirror(plan)).toEqual({
      text: `${reasoning.text}\n${payload.text}`,
      mediaUrls: [secondaryPath, primaryPath],
    });
  });
});
