import { describe, expect, it, vi } from "vitest";
import { setReplyPayloadMetadata } from "../auto-reply/reply-payload.js";
import {
  isPotentialTruncatedFinal,
  resolveTranscriptBackedChannelFinalText,
  selectLongerFinalText,
} from "./streaming-final-text.js";

describe("channel final text recovery", () => {
  it("keeps complete replies with long blank runs without stalling or reading candidates", async () => {
    const finalText = `before${"\n".repeat(60_000)}after`;
    const resolveCandidateText = vi.fn(async () => "unused");
    const started = performance.now();
    await expect(
      resolveTranscriptBackedChannelFinalText({
        payload: { text: finalText },
        finalText,
        resolveCandidateText,
      }),
    ).resolves.toBe(finalText);
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(resolveCandidateText).not.toHaveBeenCalled();
  });

  it("selects a longer transcript candidate for ellipsis-truncated finals", async () => {
    const fullAnswer =
      "Here is the complete final answer with enough stable prefix text before the ellipsis and enough continuation text after it.";
    const truncatedFinal =
      "Here is the complete final answer with enough stable prefix text before the ellipsis...";

    expect(isPotentialTruncatedFinal(truncatedFinal)).toBe(true);
    expect(
      selectLongerFinalText({
        finalText: truncatedFinal,
        candidateTexts: ["short", fullAnswer],
      }),
    ).toBe(fullAnswer);
    await expect(
      resolveTranscriptBackedChannelFinalText({
        payload: { text: truncatedFinal },
        finalText: truncatedFinal,
        resolveCandidateText: async () => fullAnswer,
      }),
    ).resolves.toBe(fullAnswer);
  });

  it("resolveTranscriptBackedChannelFinalText preserves a preceding input answer ending in ellipsis", async () => {
    const finalText =
      "Here is the earlier answer with enough stable prefix text before the ellipsis...";
    const candidateText =
      "Here is the earlier answer with enough stable prefix text before the ellipsis and a much longer answer to the next question.";
    const resolveCandidateText = vi.fn(async () => candidateText);
    const payload = setReplyPayloadMetadata({ text: finalText }, { precedingInputAnswer: true });

    await expect(
      resolveTranscriptBackedChannelFinalText({ payload, finalText, resolveCandidateText }),
    ).resolves.toBe(finalText);
    expect(resolveCandidateText).not.toHaveBeenCalled();
    await expect(
      resolveTranscriptBackedChannelFinalText({
        payload: { text: finalText },
        finalText,
        resolveCandidateText,
      }),
    ).resolves.toBe(candidateText);
    // Shipped plugin callers pass no payload and keep the latest-answer recovery.
    await expect(
      resolveTranscriptBackedChannelFinalText({ finalText, resolveCandidateText }),
    ).resolves.toBe(candidateText);
  });

  it("keeps intentional ellipsis finals when candidates do not prove truncation", async () => {
    const finalText =
      "Here is the complete final answer with enough stable prefix text before an intentional pause...";
    const candidateText =
      "Here is the complete final answer with enough stable prefix text before an intentional pause... then punctuation";

    expect(
      selectLongerFinalText({
        finalText,
        candidateTexts: [candidateText],
      }),
    ).toBeUndefined();
    await expect(
      resolveTranscriptBackedChannelFinalText({
        payload: { text: finalText },
        finalText,
        resolveCandidateText: async () => candidateText,
      }),
    ).resolves.toBe(finalText);
  });
});
