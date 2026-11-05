import { expect, it } from "vitest";
import {
  INTERNAL_RUNTIME_CONTEXT_BEGIN,
  INTERNAL_RUNTIME_CONTEXT_END,
} from "../../agents/internal-runtime-context.js";
import { setReplyPayloadMetadata } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import { markInboundContextLabel } from "./inbound-context-marker.js";
import { sanitizePendingFinalDeliveryText as sanitizeText } from "./pending-final-delivery-state.js";
import {
  buildRecoverablePendingFinalDeliveryText as recoverText,
  normalizePendingFinalDeliveryPayloads as deliveryPayloads,
  normalizePendingFinalRecoveryPayloads as recoveryPayloads,
} from "./pending-final-delivery.js";

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

it("recovers rich-text-only presentation as plain text instead of losing the reply", () => {
  expect(
    recoverText([
      {
        text: "## Clienti \u2014 Rossi\n| Cliente | Saldo |\n| Rossi | 1.00 \u20ac |",
        presentation: { blocks: [{ type: "text", text: "styled" }] },
      },
    ]),
  ).toContain("Clienti");
  expect(
    recoverText([
      {
        text: "Pick one",
        presentation: { blocks: [{ type: "text", text: "styled" }] },
        interactive: { blocks: [{ type: "buttons", buttons: [] }] },
      },
    ]),
  ).toBeUndefined();
  expect(
    recoverText([
      {
        text: "Chart",
        mediaUrl: "/tmp/a.png",
        presentation: { blocks: [{ type: "text", text: "styled" }] },
      },
    ]),
  ).toBeUndefined();
  expect(
    recoverText([{ text: "   ", presentation: { blocks: [{ type: "text", text: "styled" }] } }]),
  ).toBeUndefined();
});

it("refuses presentation buttons/selects without the deprecated interactive field", () => {
  expect(
    recoverText([
      {
        text: "Pick one",
        presentation: { blocks: [{ type: "buttons", buttons: [{ label: "A" }] }] },
      },
    ]),
  ).toBeUndefined();
  expect(
    recoverText([
      {
        text: "Choose",
        presentation: {
          blocks: [{ type: "select", placeholder: "Choose", options: [{ label: "A" }] }],
        },
      },
    ]),
  ).toBeUndefined();
});

it("mirrors chart/table substance into recovery without an authored fallback", () => {
  expect(
    recoverText([
      {
        text: "Quarterly results",
        presentation: {
          blocks: [
            {
              type: "table",
              caption: "Sales",
              headers: ["Region", "Total"],
              rows: [["North", 10]],
            },
          ],
        },
      },
    ]),
  ).toBe("Quarterly results\n\nSales (table)\n- Region: North; Total: 10");
  expect(
    recoverText([
      {
        text: "Shares",
        presentation: {
          blocks: [
            {
              type: "chart",
              chartType: "pie",
              title: "Split",
              segments: [{ label: "A", value: 1 }],
            },
          ],
        },
      },
    ]),
  ).toBe("Shares\n\nSplit (pie chart)\n- A: 1");
});

it("preserves presentation titles, text, and context during recovery", () => {
  expect(
    recoverText([
      {
        text: "Summary",
        presentation: {
          title: "Report",
          blocks: [
            { type: "text", text: "Actual answer" },
            { type: "context", text: "Context note" },
          ],
        },
      },
    ]),
  ).toBe("Summary\n\nReport\n\nActual answer\n\nContext note");
});

it("does not duplicate presentation content already present in text", () => {
  expect(
    recoverText([{ text: "Answer", presentation: { blocks: [{ type: "text", text: "Answer" }] } }]),
  ).toBe("Answer");
  expect(
    recoverText([
      { text: "Intro\n\nAnswer", presentation: { blocks: [{ type: "text", text: "Answer" }] } },
    ]),
  ).toBe("Intro\n\nAnswer");
});

it("keeps presentation MEDIA directive lines transport-only", () => {
  expect(
    recoverText([
      {
        text: "Example",
        presentation: { blocks: [{ type: "text", text: "MEDIA:/tmp/example.png" }] },
      },
    ]),
  ).toBeUndefined();
});

it("trusts text as complete with an authored fallback presentation", () => {
  expect(
    recoverText([
      {
        text: "North: 10",
        presentationTextMode: "fallback",
        presentation: {
          blocks: [
            {
              type: "table",
              caption: "Sales",
              headers: ["Region", "Total"],
              rows: [["North", 10]],
            },
          ],
        },
      },
    ]),
  ).toBe("North: 10");
});
