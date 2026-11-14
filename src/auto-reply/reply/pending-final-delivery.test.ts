import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it } from "vitest";
import { withAssistantReplySource } from "../../agents/embedded-agent-reply-source.js";
import {
  INTERNAL_RUNTIME_CONTEXT_BEGIN,
  INTERNAL_RUNTIME_CONTEXT_END,
} from "../../agents/internal-runtime-context.js";
import { projectAssistantTranscriptText } from "../../config/sessions/transcript-assistant-delivery-read.js";
import { getReplyPayloadMetadata, setReplyPayloadMetadata } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import { markInboundContextLabel } from "./inbound-context-marker.js";
import { sanitizePendingFinalDeliveryText as sanitizeText } from "./pending-final-delivery-state.js";
import {
  buildRecoverablePendingFinalDeliveryText as recoverText,
  normalizePendingFinalDeliveryPayloads as deliveryPayloads,
  normalizePendingFinalRecoveryPayloads as recoveryPayloads,
} from "./pending-final-delivery.js";
import { applyReplyThreading } from "./reply-payloads-base.js";

function expectRecovery(payloads: ReplyPayload[], text?: string) {
  expect(recoverText(payloads)).toBe(text);
}

it("strips internal metadata from durable pending delivery text", () => {
  const text = [
    "Visible reply",
    INTERNAL_RUNTIME_CONTEXT_BEGIN,
    "internal detail",
    INTERNAL_RUNTIME_CONTEXT_END,
    "",
    markInboundContextLabel("Conversation info:"),
    "```json",
    '{"message_id":"msg-1"}',
    "```",
  ].join("\n");

  expect(sanitizeText(text)).toBe("Visible reply");
});

it.each(["    const value = 1;\n    use(value);", "NO_REPLY", "NO_REPLY\nAnswer.\n    Code."])(
  "preserves prepared text without reinterpreting it: %s",
  (text) => expect(sanitizeText(text)).toBe(text),
);

it("keeps media directives in the durable recovery text while sendable delivery parses them", () => {
  const text = "Rendered chart\nMEDIA:/tmp/chart.png";
  const rawPayloads = [{ text }];
  expect(recoveryPayloads(rawPayloads).map((payload) => payload.text)).toEqual([text]);
  expect(deliveryPayloads(rawPayloads).map((payload) => payload.text)).toEqual(["Rendered chart"]);
});

it.each<[ReplyPayload[], string]>([
  [
    [{ text: "Rendered chart", mediaUrl: "/tmp/chart.png" }],
    "Rendered chart\nMEDIA:/tmp/chart.png",
  ],
  [
    [
      {
        text: "MEDIA:/tmp/c.png",
        mediaUrls: [" /tmp/a.png ", "/tmp/b.png", "/tmp/a.png", " "],
        mediaUrl: " /tmp/b.png ",
      },
    ],
    "MEDIA:/tmp/a.png\nMEDIA:/tmp/b.png\nMEDIA:/tmp/c.png",
  ],
  [[{ text: "Visible", mediaUrl: " " }], "Visible"],
  [[{ text: "Visible final", replyToId: "source-message" }], "Visible final"],
  [
    [{ text: "No channel reply." }, { text: "visible final" }],
    "No channel reply.\n\nvisible final",
  ],
  [[{ text: "No channel reply." }], "No channel reply."],
])("encodes replayable payloads without losing text or media: %j", expectRecovery);

it.each<ReplyPayload[]>([
  [{ text: "Pick one", interactive: { blocks: [{ type: "buttons", buttons: [] }] } }],
  [{ text: "Secret image", mediaUrl: "/tmp/secret.png", sensitiveMedia: true }],
  [{ text: "[[reply_to_current]] visible final" }],
  [
    setReplyPayloadMetadata(
      { text: "Visible final", replyToId: "source-message" },
      { replyToIdExplicit: true },
    ),
  ],
  [
    { text: "A", mediaUrl: "/tmp/a.png" },
    { text: "B", mediaUrl: "/tmp/b.png" },
  ],
  [{ text: "A\nMEDIA:/tmp/a.png" }, { text: "B" }],
])("refuses recovery that would lose payload semantics: %j", (...payloads) => {
  expectRecovery(payloads);
});

it.each(["first", "all"] as const)(
  "keeps a producer-selected implicit source replayable through final threading (%s)",
  (replyToMode) => {
    const payload = withAssistantReplySource({ text: "Replayable answer" }, "101");
    const finals = applyReplyThreading({
      payloads: [payload],
      replyToMode,
      replyToChannel: "telegram",
      currentMessageId: "103",
    });
    expect(finals[0]?.replyToId).toBe("101");
    expect(recoverText(recoveryPayloads(finals))).toBe("Replayable answer");
  },
);

it("retains explicit inline quotes after capturing an implicit source", () => {
  const payload = withAssistantReplySource({ text: "[[reply_to:90]] Explicit answer" }, "101");
  const finals = applyReplyThreading({
    payloads: [payload],
    replyToMode: "all",
    replyToChannel: "telegram",
    currentMessageId: "103",
  });
  expect(finals[0]).toMatchObject({ text: "Explicit answer", replyToId: "90", replyToTag: true });
  expect(
    getReplyPayloadMetadata(expectDefined(finals[0], "prepared final"))?.replyToIdExplicit,
  ).toBe(true);
  expect(recoverText(finals)).toBeUndefined();
});

it.each([
  {
    name: "old text-only transcript",
    transcript: '{"role":"assistant","content":[{"type":"text","text":"Stored answer"}]}',
    expectedTarget: "103",
    expectedText: "Stored answer",
  },
  {
    name: "old explicit quote",
    transcript:
      '{"role":"assistant","content":[{"type":"text","text":"Stored answer"}],"openclawDelivery":{"replyToId":"90"}}',
    expectedTarget: "90",
    expectedText: undefined,
  },
  {
    name: "new implicit source",
    transcript:
      '{"role":"assistant","content":[{"type":"text","text":"Stored answer"}],"openclawDelivery":{"sourceMessageId":"101"}}',
    expectedTarget: "101",
    expectedText: "Stored answer",
  },
])(
  "loads $name through final reply preparation",
  ({ transcript, expectedTarget, expectedText }) => {
    const stored: unknown = JSON.parse(transcript);
    const projected = projectAssistantTranscriptText(stored);
    expect(projected?.text).toBe("Stored answer");
    const payload = withAssistantReplySource(
      {
        text: projected?.text,
        ...(projected?.openclawDelivery?.replyToId
          ? { replyToId: projected.openclawDelivery.replyToId }
          : {}),
      },
      projected?.openclawDelivery?.sourceMessageId,
    );
    const finals = applyReplyThreading({
      payloads: [payload],
      replyToMode: "all",
      replyToChannel: "telegram",
      currentMessageId: "103",
    });
    expect(finals[0]?.replyToId).toBe(expectedTarget);
    expect(recoverText(finals)).toBe(expectedText);
  },
);
