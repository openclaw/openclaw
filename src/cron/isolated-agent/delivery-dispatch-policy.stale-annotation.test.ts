// Lateness-annotation invariants for stale one-shot deliveries (#131491).
import { expect, it } from "vitest";
import {
  getReplyPayloadMetadata,
  setReplyPayloadMetadata,
  type ReplyPayload,
} from "../../auto-reply/reply-payload.js";
import { prependStaleCronDeliveryNotice } from "./delivery-dispatch-policy.js";

const NOTICE = "⏰ Late automation run: scheduled for X, started 240m late.";

it("preserves WeakMap payload metadata on the annotated clone", async () => {
  const report: ReplyPayload = { text: "Morning report." };
  // Speech facts live in WeakMap metadata; a bare spread would drop them and
  // downstream TTS would speak the visible text instead of the authored speech.
  setReplyPayloadMetadata(report, { ttsExplicit: true });

  const [annotated] = prependStaleCronDeliveryNotice([report], NOTICE);

  expect(annotated?.text).toBe(`${NOTICE}\n\nMorning report.`);
  expect(getReplyPayloadMetadata(annotated!)).toMatchObject({ ttsExplicit: true });
});

it("keeps linked fallback payloads equal to the annotated source", async () => {
  const report: ReplyPayload = { text: "Morning report." };
  // Channel batch normalizers (e.g. Telegram buttons) merge a metadata-only
  // payload into its source only while payload.text, fallbackText.text, and
  // the source text stay equal; a drifted trio sends an unannotated duplicate.
  const buttons: ReplyPayload = {
    text: "Morning report.",
    fallbackText: { text: "Morning report.", replacesPayloadIndex: 0 },
    channelData: { telegram: { buttons: [[{ text: "Open", url: "https://x" }]] } },
  };

  const [annotated, linked] = prependStaleCronDeliveryNotice([report, buttons], NOTICE);

  const annotatedText = `${NOTICE}\n\nMorning report.`;
  expect(annotated?.text).toBe(annotatedText);
  expect(linked?.text).toBe(annotatedText);
  expect(linked?.fallbackText).toEqual({ text: annotatedText, replacesPayloadIndex: 0 });
});

it("leads with the notice for media-only batches without touching payloads", async () => {
  const media: ReplyPayload = { mediaUrls: ["https://example.com/a.png"] };
  const result = prependStaleCronDeliveryNotice([media], NOTICE);
  expect(result).toEqual([{ text: NOTICE }, media]);
});
