import { describe, expect, it } from "vitest";
import { normalizeMediaReferenceForComparison } from "../../media/media-reference-comparison.js";
import { buildAssistantDisplayRewrite } from "./chat-transcript-persistence.js";

const mediaUrl = "/tmp/hook-caption.png";
const image = { type: "image", url: "/api/chat/media/outgoing/hook/full" };
const caption = "Caption.";
const footer = "FOOTER LINE";

function displayContentFor(hookFinalizedText: string, retainOriginalText?: true) {
  const rewrite = buildAssistantDisplayRewrite({
    message: {
      role: "assistant",
      api: "cli",
      provider: "claude-cli",
      stopReason: "stop",
      idempotencyKey: "cli-assistant:hook-caption",
      content: [{ type: "text", text: hookFinalizedText }],
    },
    displayContent: [{ type: "text", text: caption }, image],
    mediaBySource: new Map([[normalizeMediaReferenceForComparison(mediaUrl), [image]]]),
    managedMediaUrls: [mediaUrl],
    ...(retainOriginalText ? { retainOriginalText } : {}),
  });
  return rewrite.openclawDisplayContent as Array<Record<string, unknown>>;
}

function visibleText(display: Array<Record<string, unknown>>) {
  return display
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => String(block.text).trim());
}

// #206571: a `before_message_write` hook appends a footer after the delivered caption.
// The hook-finalized text then differs from the pre-hook delivery payload. Both display
// rewrite paths must keep the hook-edited text once, instead of dropping it (keyed path)
// or duplicating the original caption (retained/turn-index path).
describe("before_message_write caption with appended hook text", () => {
  const hookFinalized = `${caption}\n\nMEDIA:${mediaUrl}\n\n${footer}`;

  it("keeps the hook-added footer on the idempotency-key path", () => {
    expect(visibleText(displayContentFor(hookFinalized))).toEqual([caption, footer]);
  });

  it("keeps the hook-added footer once on the retained turn-index path", () => {
    expect(visibleText(displayContentFor(hookFinalized, true))).toEqual([caption, footer]);
  });

  it("does not change replies without hook-added text", () => {
    const noFooter = `${caption}\n\nMEDIA:${mediaUrl}`;
    expect(visibleText(displayContentFor(noFooter))).toEqual([caption]);
    expect(visibleText(displayContentFor(noFooter, true))).toEqual([caption]);
  });
});
